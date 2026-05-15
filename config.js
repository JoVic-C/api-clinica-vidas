require("dotenv").config();

const num = (v, def) => (v === undefined || v === "" ? def : Number(v));
const bool = (v, def) => (v === undefined ? def : v !== "false");

module.exports = {
  TIMEZONE: process.env.TIMEZONE || "America/Sao_Paulo",
  PORT: num(process.env.PORT, 3000),

  mdmed: {
    baseUrl: process.env.MDMED_BASE_URL,
    token: process.env.MDMED_TOKEN,
    timeoutMs: num(process.env.MDMED_TIMEOUT_MS, 30000),
  },

  maischat: {
    baseUrl: process.env.MAISCHAT_BASE_URL,
    token: process.env.MAISCHAT_TOKEN,
    timeoutMs: num(process.env.MAISCHAT_TIMEOUT_MS, 30000),
    broker: process.env.MAISCHAT_BROKER || "wppCloudAPI",
    appId: process.env.MAISCHAT_APP_ID,
    source: process.env.MAISCHAT_SOURCE,
    metaToken: process.env.MAISCHAT_META_TOKEN,
    templateConfirmacao: process.env.MAISCHAT_TEMPLATE_NAME || "confirma_agendamento",
    templateLembrete: process.env.MAISCHAT_TEMPLATE_LEMBRETE || "lembrete",
    templateLang: process.env.MAISCHAT_TEMPLATE_LANGUAGE || "pt_BR",
    defaultCountryCode: process.env.MAISCHAT_DEFAULT_COUNTRY_CODE || "55",
  },

  dias: {
    confirmacao: num(process.env.DIAS_CONFIRMACAO, 5),
    lembrete: num(process.env.DIAS_LEMBRETE, 3),
    janelaResposta: num(process.env.DIAS_JANELA_RESPOSTA, 30),
    autoDesambiguacao: num(process.env.DIAS_AUTO_DESAMBIGUACAO, 7),
    toleranciaEscolha: num(process.env.DIAS_TOLERANCIA_ESCOLHA, 2),
  },

  cron: {
    loteExpr: process.env.CRON_LOTE_EXPR || "0 8 * * *",
    loteAtivo: bool(process.env.CRON_LOTE_ATIVO, true),
    lembreteExpr: process.env.CRON_LEMBRETE_EXPR || "0 8 * * *",
    lembreteAtivo: bool(process.env.CRON_LEMBRETE_ATIVO, true),
  },

  cache: {
    // Entradas do cache-lote.json cuja data do agendamento for mais antiga
    // que (hoje - retencaoDias) são removidas no próximo marcarEnviadoNoLote.
    retencaoDias: num(process.env.CACHE_LOTE_RETENCAO_DIAS, 7),
  },
};
