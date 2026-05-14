const fs = require("fs");
const path = require("path");
const { cache: cacheCfg } = require("../config");
const { dataRelativaISO } = require("./utils");

// Persiste em arquivo { "tipo:dataAlvo": [codeAgendamento, ...] }.
// Tipo separa "confirmacao" e "lembrete" — um agendamento pode receber ambos.
const CACHE_LOTE_PATH = process.env.CACHE_LOTE_PATH || path.join(__dirname, "..", "cache-lote.json");

function lerCacheLote() {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_LOTE_PATH, "utf8")); } catch { return {}; }
  // Migração: chaves antigas só com data → "confirmacao:data"
  for (const k of Object.keys(cache)) {
    if (!k.includes(":")) {
      const novaChave = `confirmacao:${k}`;
      cache[novaChave] = [...new Set([...(cache[novaChave] || []), ...cache[k]])];
      delete cache[k];
    }
  }
  return cache;
}

function salvarCacheLote(cache) {
  try { fs.writeFileSync(CACHE_LOTE_PATH, JSON.stringify(cache, null, 2), "utf8"); }
  catch (e) { console.error("Falha ao salvar cache-lote.json:", e.message); }
}

function jaEnviadoNoLote(tipo, date, code) {
  return (lerCacheLote()[`${tipo}:${date}`] || []).includes(code);
}

function marcarEnviadoNoLote(tipo, date, code) {
  const cache = lerCacheLote();
  const chave = `${tipo}:${date}`;
  cache[chave] = cache[chave] || [];
  if (!cache[chave].includes(code)) cache[chave].push(code);
  // limpa entradas cuja data do agendamento já passou há mais de cacheCfg.retencaoDias
  const limite = dataRelativaISO(-cacheCfg.retencaoDias);
  for (const k of Object.keys(cache)) {
    const dataChave = k.split(":")[1] || k;
    if (dataChave < limite) delete cache[k];
  }
  salvarCacheLote(cache);
}

module.exports = { jaEnviadoNoLote, marcarEnviadoNoLote };
