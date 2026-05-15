const axios = require("axios");
const { mdmed: mdmedConfig, dias } = require("../config");
const { codesNoCache } = require("./cache");
const {
  variantesTelefoneMdmed,
  formatarDataBR,
  parseDataMdmed,
  normalizarDataYMD,
} = require("./utils");

// ─── Cliente HTTP ────────────────────────────────────────────────────────────

async function mdmedGet(path, params) {
  return axios.get(`${mdmedConfig.baseUrl}${path}`, {
    params,
    timeout: mdmedConfig.timeoutMs,
    headers: { Authorization: `Bearer ${mdmedConfig.token}`, Accept: "application/json" },
  });
}

async function mdmedPut(path, body) {
  return axios.put(`${mdmedConfig.baseUrl}${path}`, body, {
    timeout: mdmedConfig.timeoutMs,
    headers: {
      Authorization: `Bearer ${mdmedConfig.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

// ─── Agendamentos ────────────────────────────────────────────────────────────

async function listarAgendamentosPaginado(params) {
  const all = [];
  let page = 1;
  let lastPage = 1;
  do {
    const { data } = await mdmedGet("/appointment", { ...params, page });
    all.push(...(data?.data || []));
    lastPage = data?.meta?.last_page ?? 1;
    page += 1;
  } while (page <= lastPage);
  return all;
}

function resumirAgendamento(a) {
  const { data, horario } = formatarDataBR(a.start_datetime);
  return {
    code: a.code,
    status: a.status,
    start_datetime: a.start_datetime,
    data,
    horario,
    description: a.description,
  };
}

// Escolhe o agendamento alvo de uma confirmação/cancelamento.
// - Se `data` informada: busca exata por aquele dia.
// - Senão: usa janela [hoje, hoje + diasAntes + tolerancia] para tolerar
//   respostas tardias do paciente.
function escolherAgendamento(agendamentos, {
  data,
  diasAntes = dias.confirmacao,
  tolerancia = dias.toleranciaEscolha,
  agora = new Date(),
} = {}) {
  let pool;

  if (data) {
    const ymd = normalizarDataYMD(data);
    if (!ymd) return { ok: false, motivo: "data_invalida" };
    pool = agendamentos.filter((a) => String(a.start_datetime).startsWith(ymd));
  } else {
    const fim = new Date(agora);
    fim.setDate(fim.getDate() + diasAntes + tolerancia);
    pool = agendamentos
      .map((a) => ({ a, t: parseDataMdmed(a.start_datetime) }))
      .filter((x) => x.t && x.t >= agora && x.t <= fim)
      .sort((x, y) => x.t - y.t)
      .map((x) => x.a);
  }

  if (pool.length === 0) return { ok: false, motivo: "nao_encontrado" };

  const agendados = pool.filter((a) => a.status === "Agendado");
  if (agendados.length === 1) return { ok: true, agendamento: agendados[0] };
  if (agendados.length > 1) return { ok: false, motivo: "ambiguo", candidatos: agendados };

  if (pool.length === 1) return { ok: true, agendamento: pool[0] };
  return { ok: false, motivo: "ambiguo", candidatos: pool };
}

async function mudarStatusAgendamento({ ag, novoStatus }) {
  if (ag.status === novoStatus) {
    return { sucesso: true, idempotente: true, agendamento: resumirAgendamento(ag) };
  }
  if (novoStatus === "Confirmado" && ag.status === "Cancelado") {
    return {
      sucesso: false,
      motivo: "cancelado_nao_reconfirmavel",
      mensagem: "Agendamento foi cancelado e não pode ser reconfirmado.",
      agendamento: resumirAgendamento(ag),
    };
  }
  try {
    const { data } = await mdmedPut(`/appointment/${ag.code}`, { status: novoStatus });
    return {
      sucesso: true,
      agendamento: data?.data ? resumirAgendamento(data.data) : resumirAgendamento({ ...ag, status: novoStatus }),
    };
  } catch (error) {
    return {
      sucesso: false,
      motivo: "erro_mdmed",
      mensagem: error.response?.data?.message || error.message,
      agendamento: resumirAgendamento(ag),
    };
  }
}

// ─── Pacientes ───────────────────────────────────────────────────────────────

async function buscarPacientesPorTelefone(phone) {
  const variantes = variantesTelefoneMdmed(phone);
  if (variantes.length === 0) return [];
  console.log(`  buscarPacientesPorTelefone: ${phone} → variantes=${JSON.stringify(variantes)}`);
  const encontrados = new Map();
  for (const variante of variantes) {
    const { data } = await mdmedGet("/patient", { phone_number: variante });
    for (const p of data?.data || []) {
      if (!encontrados.has(p.code)) encontrados.set(p.code, p);
    }
  }
  console.log(`  → ${encontrados.size} paciente(s) encontrado(s)`);
  return [...encontrados.values()];
}

function escolherPaciente(pacientes, { patientId, cpf } = {}) {
  if (pacientes.length === 0) return { ok: false, motivo: "nao_encontrado" };

  if (patientId) {
    const p = pacientes.find((x) => String(x.code) === String(patientId));
    if (p) return { ok: true, paciente: p };
    return { ok: false, motivo: "patientId_nao_corresponde", candidatos: pacientes };
  }
  if (cpf) {
    const cpfLimpo = String(cpf).replace(/\D/g, "");
    const p = pacientes.find((x) => String(x.cpf || "").replace(/\D/g, "") === cpfLimpo);
    if (p) return { ok: true, paciente: p };
    return { ok: false, motivo: "cpf_nao_corresponde", candidatos: pacientes };
  }
  if (pacientes.length === 1) return { ok: true, paciente: pacientes[0] };
  return { ok: false, motivo: "telefone_duplicado", candidatos: pacientes };
}

async function resolverPaciente({ phone, patientId, cpf }) {
  const pacientes = await buscarPacientesPorTelefone(phone);
  return escolherPaciente(pacientes, { patientId, cpf });
}

/**
 * Resolve o paciente quando o telefone tem múltiplos cadastros (família).
 *  - Se patientId/cpf vier, usa a desambiguação tradicional.
 *  - Se DataAgendamento (dataYMD) vier, filtra agendamentos por essa data.
 *  - Sem nenhum dos dois:
 *      1ª tentativa: cruza agendamentos da família com cache-lote.json
 *                    (templates já enviados — desambiguação 100% precisa)
 *      2ª tentativa: usa a janela dias.autoDesambiguacao à frente
 *                    (heurística: confirmação foi enviada ~5 dias antes da consulta)
 */
async function resolverPacienteComData({ phone, patientId, cpf, dataYMD }) {
  const pacientes = await buscarPacientesPorTelefone(phone);

  const escolhaInicial = escolherPaciente(pacientes, { patientId, cpf });
  if (escolhaInicial.ok) return escolhaInicial;
  if (escolhaInicial.motivo !== "telefone_duplicado") return escolhaInicial;

  const codesEnviados = !dataYMD ? codesNoCache(["confirmacao", "lembrete"]) : null;

  const filtrarAlvo = (ags) => {
    if (dataYMD) {
      return ags.filter((a) => String(a.start_datetime).startsWith(dataYMD));
    }
    // Estratégia 1: cruzar com cache de envios (preciso)
    const noCache = ags.filter((a) => codesEnviados.has(a.code));
    if (noCache.length > 0) return noCache;
    // Estratégia 2 (fallback): janela à frente
    const agora = new Date();
    const fim = new Date(agora);
    fim.setDate(fim.getDate() + dias.autoDesambiguacao);
    return ags
      .map((a) => ({ a, t: parseDataMdmed(a.start_datetime) }))
      .filter((x) => x.t && x.t >= agora && x.t <= fim)
      .map((x) => x.a);
  };

  const criterio = dataYMD
    ? `data ${dataYMD}`
    : `cache-de-envios + janela ${dias.autoDesambiguacao} dias (fallback)`;
  console.log(`  resolverPacienteComData: ${pacientes.length} pacientes, filtrando por ${criterio}`);

  const candidatos = [];
  for (const p of pacientes) {
    const ags = await listarAgendamentosPaginado({ patientId: p.code });
    const alvo = filtrarAlvo(ags);
    if (alvo.length > 0) {
      candidatos.push({ paciente: p, agendamentos: ags, agendamentosAlvo: alvo });
    }
  }

  if (candidatos.length === 1) {
    const c = candidatos[0];
    console.log(`  → desambiguado: ${c.paciente.name} (code=${c.paciente.code}, ${c.agendamentosAlvo.length} agendamento(s) alvo)`);
    return { ok: true, paciente: c.paciente, agendamentosPreCarregados: c.agendamentos };
  }
  if (candidatos.length === 0) {
    console.log(`  → nenhum paciente da família tem agendamento ${criterio} — mantém 409`);
    return escolhaInicial;
  }
  console.log(`  → família detectada: ${candidatos.length} pacientes com agendamento ${criterio}`);
  return { ok: true, multiplos: true, pacientesMultiplos: candidatos };
}

module.exports = {
  // client
  mdmedGet,
  mdmedPut,
  // agendamentos
  listarAgendamentosPaginado,
  resumirAgendamento,
  escolherAgendamento,
  mudarStatusAgendamento,
  // pacientes
  buscarPacientesPorTelefone,
  escolherPaciente,
  resolverPaciente,
  resolverPacienteComData,
};
