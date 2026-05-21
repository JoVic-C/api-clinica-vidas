const { maischat, dias } = require("../config");
const { listarAgendamentosPaginado } = require("./mdmed");
const { enviarMaisChat, montarPayloadTemplate, criarContato } = require("./maischat");
const { jaEnviadoNoLote, marcarEnviadoNoLote } = require("./cache");
const { formatarDataBR, formatarCelular, normalizarDataYMD, dataRelativaISO } = require("./utils");

// Confirmação: enviado N dias antes para agendamentos "Agendado"
//   (paciente ainda não confirmou — pedimos confirmação).
// Lembrete:    enviado M dias antes para agendamentos "Confirmado"
//   (paciente já confirmou — só lembramos da consulta).
const LOTE_CONFIRMACAO = {
  tipo: "confirmacao",
  template: () => maischat.templateConfirmacao,
  status: "Agendado",
  diasPadrao: dias.confirmacao,
  incluirDescricao: true,
};
const LOTE_LEMBRETE = {
  tipo: "lembrete",
  template: () => maischat.templateLembrete,
  status: "Confirmado",
  diasPadrao: dias.lembrete,
  incluirDescricao: false,
};

async function executarLote(config, { date, diasAntes, supplierId } = {}) {
  const diasUsados = diasAntes !== undefined ? Number(diasAntes) : config.diasPadrao;
  const dataAlvo = date
    ? normalizarDataYMD(date) || String(date).slice(0, 10)
    : dataRelativaISO(diasUsados);

  let agendamentos = await listarAgendamentosPaginado({ date: dataAlvo });
  let supplierName = null;
  if (supplierId !== undefined && supplierId !== null && supplierId !== "") {
    const supId = String(supplierId);
    agendamentos = agendamentos.filter((a) => String(a.supplier_id) === supId);
    supplierName = agendamentos[0]?.supplier_name || null;
  }
  const doStatus = agendamentos.filter((a) => a.status === config.status);
  const semTelefone = doStatus.filter((a) => !a.patient_phone);
  const elegiveis = doStatus.filter(
    (a) => a.patient_phone && !jaEnviadoNoLote(config.tipo, dataAlvo, a.code),
  );
  const jaProcessados = doStatus.filter(
    (a) => a.patient_phone && jaEnviadoNoLote(config.tipo, dataAlvo, a.code),
  ).length;

  const enviados = [];
  const falhas = [];

  for (const ag of elegiveis) {
    const { data, horario } = formatarDataBR(ag.start_datetime);
    const destination = formatarCelular(ag.patient_phone);
    try {
      const payload = montarPayloadTemplate({
        template: config.template(),
        destination,
        nomePaciente: ag.patient_name,
        descricao: ag.description,
        data,
        horario,
        incluirDescricao: config.incluirDescricao,
      });
      const response = await enviarMaisChat(payload);
      const ok = response?.data?.status !== false;
      if (ok) {
        enviados.push({
          code: ag.code,
          destination,
          data,
          horario,
          msgId: response?.data?.data?.msgId,
          patient_name: ag.patient_name,
        });
        marcarEnviadoNoLote(config.tipo, dataAlvo, ag.code);
      } else {
        falhas.push({ code: ag.code, motivo: response?.data?.message || "Falha desconhecida" });
      }
    } catch (err) {
      falhas.push({ code: ag.code, motivo: err.response?.data?.message || err.message });
    }
  }

  // Sincroniza contatos na MaisChat só para confirmação (lembrete já tem o contato).
  const contatos = { criados: 0, atualizados: 0, jaExistiam: 0, falhas: 0, detalhes: [] };
  if (config.tipo === "confirmacao" && enviados.length > 0) {
    const vistos = new Set();
    for (const e of enviados) {
      if (!e.patient_name) continue;
      const chave = `${e.destination}|${e.patient_name}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);

      const r = await criarContato({ nome: e.patient_name, celular: e.destination });
      if (r.criado) contatos.criados += 1;
      else if (r.atualizado) contatos.atualizados += 1;
      else if (r.jaExiste) contatos.jaExistiam += 1;
      else {
        contatos.falhas += 1;
        contatos.detalhes.push({ nome: e.patient_name, celular: e.destination, motivo: r.motivo });
      }
    }
  }

  return {
    sucesso: true,
    tipo: config.tipo,
    template: config.template(),
    date: dataAlvo,
    supplierId: supplierId ?? null,
    supplierName,
    total: agendamentos.length,
    totalElegiveis: elegiveis.length,
    totalJaProcessados: jaProcessados,
    totalSemTelefone: semTelefone.length,
    totalEnviados: enviados.length,
    totalFalhas: falhas.length,
    enviados,
    falhas,
    semTelefone: semTelefone.map((a) => ({ code: a.code, patient_name: a.patient_name })),
    contatos,
  };
}

module.exports = { LOTE_CONFIRMACAO, LOTE_LEMBRETE, executarLote };
