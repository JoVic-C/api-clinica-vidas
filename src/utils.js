const { TIMEZONE, maischat } = require("../config");

function formatarCelular(celular) {
  const digitos = String(celular || "").replace(/\D/g, "");
  if (digitos.startsWith(maischat.defaultCountryCode) && digitos.length >= 12) return digitos;
  return `${maischat.defaultCountryCode}${digitos}`;
}

// Gera as variantes de telefone para busca na MdmedAPI.
// Cobre as 4 combinações: com/sem prefixo "55" e com/sem "9" após o DDD,
// porque os cadastros não seguem um padrão único.
function variantesTelefoneMdmed(celular) {
  let digitos = String(celular || "").replace(/\D/g, "");
  if (!digitos) return [];

  if (digitos.startsWith(maischat.defaultCountryCode) && digitos.length >= 12) {
    digitos = digitos.slice(maischat.defaultCountryCode.length);
  }
  const ddd = digitos.slice(0, 2);
  const numero = digitos.slice(2);

  const semPrefixo = new Set([digitos]);
  if (numero.length === 8) semPrefixo.add(`${ddd}9${numero}`);
  if (numero.length === 9 && numero.startsWith("9")) semPrefixo.add(`${ddd}${numero.slice(1)}`);

  const variantes = new Set();
  for (const v of semPrefixo) {
    variantes.add(v);
    variantes.add(`${maischat.defaultCountryCode}${v}`);
  }

  return [...variantes];
}

function formatarDataBR(datetimeStr) {
  if (!datetimeStr) return { data: "??", horario: "??" };
  const iso = String(datetimeStr).replace(" ", "T").replace(/\s+/g, "");
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { data: "??", horario: "??" };
  const data = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric",
  }).format(d);
  const horario = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit",
  }).format(d);
  return { data, horario };
}

function todayISO() {
  return dataRelativaISO(0);
}

function dataRelativaISO(dias = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function parseDataMdmed(s) {
  if (!s) return null;
  const iso = String(s).replace(" ", "T").replace(/\s+/g, "");
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

// Aceita "YYYY-MM-DD..." ou "DD/MM/YYYY" e retorna sempre "YYYY-MM-DD"
function normalizarDataYMD(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function handleError(error, res) {
  if (error.response) {
    const status = error.response.status;
    if (status === 401) return res.status(401).json({ sucesso: false, mensagem: "Não autorizado." });
    if (status === 404) return res.status(404).json({ sucesso: false, mensagem: "Recurso não encontrado." });
    return res.status(status).json({
      sucesso: false,
      mensagem: `Erro externo: ${error.response.statusText}`,
      detalhe: error.response.data,
    });
  }
  return res.status(500).json({ sucesso: false, mensagem: "Erro de conexão.", detalhe: error.message });
}

module.exports = {
  formatarCelular,
  variantesTelefoneMdmed,
  formatarDataBR,
  todayISO,
  dataRelativaISO,
  parseDataMdmed,
  normalizarDataYMD,
  handleError,
};
