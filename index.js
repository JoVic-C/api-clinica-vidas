const express = require("express");
const cron = require("node-cron");

const { TIMEZONE, PORT, cron: cronCfg, dias, maischat } = require("./config");
const {
  formatarCelular,
  formatarDataBR,
  todayISO,
  normalizarDataYMD,
  handleError,
} = require("./src/utils");
const {
  listarAgendamentosPaginado,
  resumirAgendamento,
  escolherAgendamento,
  mudarStatusAgendamento,
  resolverPaciente,
  resolverPacienteComData,
} = require("./src/mdmed");
const {
  enviarMaisChat,
  montarPayloadTemplate,
  templateIncluiDescricao,
  criarContato,
} = require("./src/maischat");
const {
  LOTE_CONFIRMACAO,
  LOTE_LEMBRETE,
  executarLote,
} = require("./src/lotes");

const app = express();
app.use(express.json());

// ─── Middleware de Log ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const inicio = Date.now();
  const timestamp = new Date().toLocaleString("pt-BR", { timeZone: TIMEZONE });
  console.log(`\n[${timestamp}] ${req.method} ${req.path}`);
  if (req.body && Object.keys(req.body).length > 0) console.log("  Body:", JSON.stringify(req.body));
  if (req.query && Object.keys(req.query).length > 0) console.log("  Query:", JSON.stringify(req.query));
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    console.log(`  Status: ${res.statusCode} | ${Date.now() - inicio}ms | sucesso: ${data?.sucesso ?? "-"}`);
    return originalJson(data);
  };
  next();
});

// ─── Adapters HTTP (orquestram lógica + res) ─────────────────────────────────

function responderErroPaciente(res, escolha) {
  if (escolha.motivo === "telefone_duplicado") {
    return res.status(409).json({
      sucesso: false,
      mensagem: "Mais de um paciente com este telefone. Informe 'patientId' ou 'cpf' para desambiguar.",
      candidatos: escolha.candidatos,
    });
  }
  if (escolha.motivo === "patientId_nao_corresponde" || escolha.motivo === "cpf_nao_corresponde") {
    return res.status(404).json({
      sucesso: false,
      mensagem: "Identificador informado não corresponde a nenhum paciente com este telefone.",
      candidatos: escolha.candidatos,
    });
  }
  return res.status(404).json({ sucesso: false, mensagem: "Paciente não encontrado." });
}

async function aplicarMudancaStatus({ res, paciente, escolha, novoStatus }) {
  if (!escolha.ok) {
    if (escolha.motivo === "ambiguo") {
      return res.status(409).json({
        sucesso: false,
        mensagem: "Múltiplos agendamentos elegíveis. Informe 'DataAgendamento' para desambiguar.",
        paciente,
        candidatos: escolha.candidatos.map(resumirAgendamento),
      });
    }
    if (escolha.motivo === "data_invalida") {
      return res.status(400).json({ sucesso: false, mensagem: "Formato de 'DataAgendamento' inválido." });
    }
    return res.status(404).json({ sucesso: false, mensagem: "Nenhum agendamento elegível encontrado.", paciente });
  }

  const r = await mudarStatusAgendamento({ ag: escolha.agendamento, novoStatus });
  if (r.sucesso && r.idempotente) {
    return res.json({
      sucesso: true,
      mensagem: `Agendamento já estava como '${novoStatus}'.`,
      idempotente: true,
      paciente,
      agendamento: r.agendamento,
    });
  }
  if (!r.sucesso) {
    const status = r.motivo === "cancelado_nao_reconfirmavel" ? 409 : 502;
    return res.status(status).json({ sucesso: false, mensagem: r.mensagem, paciente, agendamento: r.agendamento });
  }
  return res.json({
    sucesso: true,
    mensagem: `Agendamento ${novoStatus.toLowerCase()}.`,
    paciente,
    agendamento: r.agendamento,
  });
}

async function mudarStatusEndpoint({ req, res, novoStatus }) {
  const { NumeroCelular, DataAgendamento, diasAntes, patientId, cpf } = req.body || {};
  if (!NumeroCelular) return res.status(400).json({ sucesso: false, mensagem: "Campo 'NumeroCelular' é obrigatório." });

  const dataYMD = DataAgendamento ? normalizarDataYMD(DataAgendamento) : null;
  if (DataAgendamento && !dataYMD) {
    return res.status(400).json({ sucesso: false, mensagem: "Formato de 'DataAgendamento' inválido." });
  }

  let escolhaPac;
  try {
    escolhaPac = await resolverPacienteComData({ phone: NumeroCelular, patientId, cpf, dataYMD });
  } catch (e) {
    return handleError(e, res);
  }
  if (!escolhaPac.ok) return responderErroPaciente(res, escolhaPac);

  // Família — múltiplos pacientes com agendamento na data ou janela
  if (escolhaPac.multiplos) {
    const resultados = [];
    for (const { paciente, agendamentosAlvo } of escolhaPac.pacientesMultiplos) {
      for (const ag of agendamentosAlvo) {
        const r = await mudarStatusAgendamento({ ag, novoStatus });
        resultados.push({
          paciente: { code: paciente.code, name: paciente.name },
          ...r,
        });
      }
    }
    const totalSucesso = resultados.filter((r) => r.sucesso).length;
    return res.json({
      sucesso: true,
      familia: true,
      mensagem: `${totalSucesso} de ${resultados.length} agendamentos com status '${novoStatus}'.`,
      criterio: dataYMD ? `data=${dataYMD}` : `janela=${dias.autoDesambiguacao}d`,
      resultados,
    });
  }

  const paciente = escolhaPac.paciente;
  let agendamentos;
  try {
    agendamentos = escolhaPac.agendamentosPreCarregados
      || (await listarAgendamentosPaginado({ patientId: paciente.code }));
  } catch (e) {
    return handleError(e, res);
  }
  const escolhaAg = escolherAgendamento(agendamentos, {
    data: DataAgendamento,
    diasAntes: diasAntes !== undefined ? Number(diasAntes) : dias.janelaResposta,
  });
  return aplicarMudancaStatus({ res, paciente, escolha: escolhaAg, novoStatus });
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

app.get("/ping", (_, res) => res.json({ pong: true }));
app.get("/health", (_, res) => res.json({ status: "ok" }));

app.get("/appointments", async (req, res) => {
  const date = req.query.date || todayISO();
  try {
    const agendamentos = await listarAgendamentosPaginado({ date });
    return res.json({ sucesso: true, date, total: agendamentos.length, agendamentos });
  } catch (error) {
    return handleError(error, res);
  }
});

/**
 * GET /suppliers?date=YYYY-MM-DD
 * Lista os médicos com agendamentos no dia (com totais por status).
 * Útil para descobrir qual supplierId usar no lote por médico.
 */
app.get("/suppliers", async (req, res) => {
  const date = req.query.date || todayISO();
  try {
    const agendamentos = await listarAgendamentosPaginado({ date });
    const map = new Map();
    for (const a of agendamentos) {
      const key = a.supplier_id;
      if (!map.has(key)) {
        map.set(key, { supplierId: a.supplier_id, supplierName: a.supplier_name, total: 0, agendado: 0, confirmado: 0, cancelado: 0 });
      }
      const s = map.get(key);
      s.total += 1;
      if (a.status === "Agendado") s.agendado += 1;
      else if (a.status === "Confirmado") s.confirmado += 1;
      else if (a.status === "Cancelado") s.cancelado += 1;
    }
    const suppliers = [...map.values()].sort((a, b) => b.total - a.total);
    return res.json({ sucesso: true, date, total: suppliers.length, suppliers });
  } catch (error) {
    return handleError(error, res);
  }
});

app.get("/appointments/by-phone", async (req, res) => {
  const { phone, patientId, cpf } = req.query;
  if (!phone) return res.status(400).json({ sucesso: false, mensagem: "Query 'phone' é obrigatória." });
  try {
    const escolha = await resolverPaciente({ phone, patientId, cpf });
    if (!escolha.ok) return responderErroPaciente(res, escolha);
    const paciente = escolha.paciente;
    const agendamentos = await listarAgendamentosPaginado({ patientId: paciente.code });
    return res.json({ sucesso: true, paciente, total: agendamentos.length, agendamentos });
  } catch (error) {
    return handleError(error, res);
  }
});

app.post("/paciente/celular", async (req, res) => {
  const { NumeroCelular, patientId, cpf } = req.body || {};
  if (!NumeroCelular) return res.status(400).json({ sucesso: false, mensagem: "Campo 'NumeroCelular' é obrigatório." });
  try {
    const escolha = await resolverPaciente({ phone: NumeroCelular, patientId, cpf });
    if (!escolha.ok) return responderErroPaciente(res, escolha);
    return res.json({ sucesso: true, paciente: escolha.paciente });
  } catch (error) {
    return handleError(error, res);
  }
});

app.post("/agendamento/enviar-confirmacao", async (req, res) => {
  const { NumeroCelular, patientId, cpf, DataAgendamento, template, diasAntes } = req.body || {};
  if (!NumeroCelular) return res.status(400).json({ sucesso: false, mensagem: "Campo 'NumeroCelular' é obrigatório." });

  let paciente;
  try {
    const escolha = await resolverPaciente({ phone: NumeroCelular, patientId, cpf });
    if (!escolha.ok) return responderErroPaciente(res, escolha);
    paciente = escolha.paciente;
  } catch (e) {
    return handleError(e, res);
  }

  let agendamentos = [];
  try {
    agendamentos = await listarAgendamentosPaginado({ patientId: paciente.code });
  } catch (e) {
    return handleError(e, res);
  }

  const escolhaAg = escolherAgendamento(agendamentos, {
    data: DataAgendamento,
    diasAntes: diasAntes !== undefined ? Number(diasAntes) : undefined,
  });
  if (!escolhaAg.ok) {
    const status = escolhaAg.motivo === "data_invalida" ? 400 : escolhaAg.motivo === "ambiguo" ? 409 : 404;
    return res.status(status).json({
      sucesso: false,
      motivo: escolhaAg.motivo,
      mensagem:
        escolhaAg.motivo === "ambiguo"
          ? "Mais de um agendamento candidato. Informe DataAgendamento."
          : "Nenhum agendamento elegível encontrado.",
      paciente,
      candidatos: escolhaAg.candidatos,
    });
  }
  const ag = escolhaAg.agendamento;
  const destination = formatarCelular(NumeroCelular);
  const { data, horario } = formatarDataBR(ag.start_datetime);
  const templateUsado = template || maischat.templateConfirmacao;

  await criarContato({ nome: ag.patient_name || paciente.name, celular: destination });

  try {
    const payload = montarPayloadTemplate({
      template: templateUsado,
      destination,
      nomePaciente: ag.patient_name || paciente.name,
      descricao: ag.description,
      data,
      horario,
      incluirDescricao: templateIncluiDescricao(templateUsado),
    });
    const response = await enviarMaisChat(payload);
    const ok = response?.data?.status !== false;
    if (!ok) {
      return res.status(502).json({
        sucesso: false,
        mensagem: response?.data?.message || "Falha ao enviar template.",
        template: templateUsado,
        paciente,
        agendamento: { code: ag.code, start_datetime: ag.start_datetime, data, horario },
      });
    }
    return res.json({
      sucesso: true,
      mensagem: "Template enviado.",
      template: templateUsado,
      paciente,
      agendamento: {
        code: ag.code,
        start_datetime: ag.start_datetime,
        status: ag.status,
        data,
        horario,
      },
      destination,
      msgId: response?.data?.data?.msgId,
    });
  } catch (err) {
    return handleError(err, res);
  }
});

app.post("/agendamento/enviar-confirmacoes", async (req, res) => {
  try {
    const resultado = await executarLote(LOTE_CONFIRMACAO, {
      date: req.body?.DataAgendamento,
      diasAntes: req.body?.diasAntes,
      supplierId: req.body?.supplierId,
    });
    return res.json(resultado);
  } catch (error) {
    return handleError(error, res);
  }
});

app.post("/agendamento/enviar-lembretes", async (req, res) => {
  try {
    const resultado = await executarLote(LOTE_LEMBRETE, {
      date: req.body?.DataAgendamento,
      diasAntes: req.body?.diasAntes,
      supplierId: req.body?.supplierId,
    });
    return res.json(resultado);
  } catch (error) {
    return handleError(error, res);
  }
});

app.post("/agendamento/confirmar-mais-recente", async (req, res) =>
  mudarStatusEndpoint({ req, res, novoStatus: "Confirmado" }));

app.post("/agendamento/cancelar-mais-recente", async (req, res) =>
  mudarStatusEndpoint({ req, res, novoStatus: "Cancelado" }));

app.post("/test/whatsapp", async (req, res) => {
  const { phone, template } = req.body || {};
  if (!phone) return res.status(400).json({ sucesso: false, mensagem: "Campo 'phone' é obrigatório." });

  const destination = formatarCelular(phone);
  const { data, horario } = formatarDataBR(new Date().toISOString());

  try {
    const templateTeste = template || maischat.templateConfirmacao;
    const payload = montarPayloadTemplate({
      template: templateTeste,
      destination,
      nomePaciente: "Paciente Teste",
      descricao: req.body?.descricao || "CONSULTA TESTE - PARTICULAR R$ 0,00",
      data,
      horario,
      incluirDescricao: templateIncluiDescricao(templateTeste),
    });
    console.log("Payload:", JSON.stringify(payload, null, 2));
    const response = await enviarMaisChat(payload);
    return res.json({
      sucesso: true,
      mensagem: "Template enviado.",
      destination,
      msgId: response?.data?.data?.msgId,
      response: response?.data,
    });
  } catch (error) {
    console.log("Erro completo MaisChat:", JSON.stringify(error.response?.data, null, 2));
    return handleError(error, res);
  }
});

// ─── Crons: lotes diários ────────────────────────────────────────────────────

function agendarCronLote({ nome, expr, config }) {
  cron.schedule(
    expr,
    async () => {
      const ts = new Date().toLocaleString("pt-BR", { timeZone: TIMEZONE });
      console.log(`\n[${ts}] [Cron ${nome}] Disparando lote...`);
      try {
        const r = await executarLote(config, {});
        console.log(
          `[Cron ${nome}] template=${r.template} date=${r.date} total=${r.total} ` +
          `elegiveis=${r.totalElegiveis} jaProcessados=${r.totalJaProcessados} ` +
          `semTelefone=${r.totalSemTelefone} enviados=${r.totalEnviados} falhas=${r.totalFalhas}`,
        );
        if (r.falhas.length > 0) console.log(`[Cron ${nome}] falhas:`, JSON.stringify(r.falhas));
        if (r.semTelefone.length > 0) console.log(`[Cron ${nome}] sem telefone:`, JSON.stringify(r.semTelefone));
      } catch (e) {
        console.error(`[Cron ${nome}] erro:`, e.response?.data || e.message);
      }
    },
    { timezone: TIMEZONE },
  );
}

if (cronCfg.loteAtivo) {
  agendarCronLote({ nome: "confirmacao", expr: cronCfg.loteExpr, config: LOTE_CONFIRMACAO });
  console.log(`[Cron] Confirmação ATIVA: "${cronCfg.loteExpr}" (TZ ${TIMEZONE}, ${dias.confirmacao} dias antes, status=Agendado, template=${maischat.templateConfirmacao})`);
} else {
  console.log("[Cron] Confirmação DESATIVADA (CRON_LOTE_ATIVO=false)");
}

if (cronCfg.lembreteAtivo) {
  agendarCronLote({ nome: "lembrete", expr: cronCfg.lembreteExpr, config: LOTE_LEMBRETE });
  console.log(`[Cron] Lembrete ATIVO: "${cronCfg.lembreteExpr}" (TZ ${TIMEZONE}, ${dias.lembrete} dias antes, status=Confirmado, template=${maischat.templateLembrete})`);
} else {
  console.log("[Cron] Lembrete DESATIVADO (CRON_LEMBRETE_ATIVO=false)");
}

app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
