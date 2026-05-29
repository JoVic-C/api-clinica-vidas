const axios = require("axios");
const { maischat } = require("../config");

async function enviarMaisChat(body) {
  return axios.post(
    `${maischat.baseUrl}/template/send/${maischat.broker}`,
    body,
    {
      timeout: maischat.timeoutMs,
      headers: { "Content-Type": "application/json", authorization: `Bearer ${maischat.token}` },
    }
  );
}

// Monta o payload do template de confirmação (4 vars: nome, descricao, data, horario).
function montarPayloadTemplate({
  template, destination, nomePaciente, descricao, data, horario,
}) {
  const parameters = [
    { type: "text", text: nomePaciente || "Paciente" },
    { type: "text", text: descricao || "Consulta/Exame" },
    { type: "text", text: data || "??" },
    { type: "text", text: horario || "??" },
  ];

  return {
    type: "apiTemplate",
    broker: maischat.broker,
    appId: maischat.appId,
    source: maischat.source,
    destination,
    token: maischat.metaToken,
    template: {
      name: template,
      language: maischat.templateLang,
      components: [{ type: "body", parameters }],
    },
  };
}

// O endpoint /contact da MaisChat exige número brasileiro sem DDI (10 dígitos para fixo, 11 para celular).
function normalizarCelularParaContato(celular) {
  const digitos = String(celular || "").replace(/\D/g, "");
  const cc = maischat.defaultCountryCode;
  if (digitos.startsWith(cc) && digitos.length >= 12) return digitos.slice(cc.length);
  return digitos;
}

async function buscarContatoPorCelular(celular) {
  try {
    const resp = await axios.get(
      `${maischat.baseUrl}/contact/cellphone/${encodeURIComponent(celular)}`,
      {
        timeout: maischat.timeoutMs,
        headers: { authorization: `Bearer ${maischat.token}` },
      },
    );
    const data = resp?.data?.data;
    const id = data?.id || data?._id || null;
    console.log(`  [buscarContatoPorCelular] OK celular=${celular} id=${id}`);
    return { encontrado: !!id, id, contato: data };
  } catch (err) {
    const status = err.response?.status;
    const respData = err.response?.data;
    console.log(`  [buscarContatoPorCelular] ERRO celular=${celular} status=${status} resp=${JSON.stringify(respData)}`);
    return { encontrado: false, motivo: respData?.message || err.message };
  }
}

async function atualizarContato({ id, nome }) {
  const body = { name: nome };
  try {
    const resp = await axios.patch(
      `${maischat.baseUrl}/contact/${id}`,
      body,
      {
        timeout: maischat.timeoutMs,
        headers: { "Content-Type": "application/json", authorization: `Bearer ${maischat.token}` },
      },
    );
    console.log(`  [atualizarContato] OK id=${id} status=${resp.status} body=${JSON.stringify(body)} resp=${JSON.stringify(resp?.data)}`);
    return { atualizado: true, contato: resp?.data?.data };
  } catch (err) {
    const status = err.response?.status;
    const respData = err.response?.data;
    console.log(`  [atualizarContato] ERRO id=${id} status=${status} body=${JSON.stringify(body)} resp=${JSON.stringify(respData)}`);
    return { atualizado: false, motivo: respData?.message || err.message };
  }
}

// Best-effort: cria; se já existe (409), tenta extrair o id e atualizar o nome via PATCH.
async function criarContato({ nome, celular }) {
  if (!nome || !celular) {
    console.log(`  [criarContato] PULADO — nome="${nome}" celular="${celular}"`);
    return { criado: false, motivo: "nome ou celular ausentes" };
  }
  const celularNormalizado = normalizarCelularParaContato(celular);
  if (celularNormalizado.length !== 10 && celularNormalizado.length !== 11) {
    console.log(`  [criarContato] PULADO — celular fora do padrão BR (10/11 dígitos): "${celular}" → "${celularNormalizado}"`);
    return { criado: false, motivo: `Número fora do padrão BR (10 ou 11 dígitos): "${celularNormalizado}"` };
  }
  const body = { name: nome, type: "pf", celular: celularNormalizado };
  try {
    const resp = await axios.post(
      `${maischat.baseUrl}/contact`,
      body,
      {
        timeout: maischat.timeoutMs,
        headers: { "Content-Type": "application/json", authorization: `Bearer ${maischat.token}` },
      },
    );
    console.log(`  [criarContato] OK status=${resp.status} body=${JSON.stringify(body)} resp=${JSON.stringify(resp?.data)}`);
    return { criado: true, contato: resp?.data?.data };
  } catch (err) {
    const status = err.response?.status;
    const respData = err.response?.data;
    console.log(`  [criarContato] ERRO status=${status} body=${JSON.stringify(body)} resp=${JSON.stringify(respData)}`);
    if (status === 409) {
      let idExistente = respData?.data?.id || respData?.data?._id || respData?.id || respData?._id;
      if (!idExistente) {
        const busca = await buscarContatoPorCelular(celularNormalizado);
        if (busca.encontrado) idExistente = busca.id;
      }
      if (idExistente) {
        const upd = await atualizarContato({ id: idExistente, nome });
        if (upd.atualizado) return { criado: false, atualizado: true, contato: upd.contato };
        return { criado: false, jaExiste: true, atualizado: false, motivo: upd.motivo };
      }
      return { criado: false, jaExiste: true, motivo: "409 e GET não retornou id" };
    }
    return { criado: false, motivo: respData?.message || err.message };
  }
}

module.exports = {
  enviarMaisChat,
  montarPayloadTemplate,
  criarContato,
};
