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

/**
 * Monta o payload do template.
 *  - incluirDescricao=true  → 4 vars: {nome, descricao, data, horario}  (confirmação)
 *  - incluirDescricao=false → 3 vars: {nome, data, horario}             (lembrete)
 */
function montarPayloadTemplate({
  template, destination, nomePaciente, descricao, data, horario,
  incluirDescricao = true,
}) {
  const parameters = [{ type: "text", text: nomePaciente || "Paciente" }];
  if (incluirDescricao) parameters.push({ type: "text", text: descricao || "Consulta/Exame" });
  parameters.push({ type: "text", text: data || "??" });
  parameters.push({ type: "text", text: horario || "??" });

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

// Detecta se o template recebido é de lembrete (3 vars) ou confirmação (4 vars).
function templateIncluiDescricao(template) {
  return template !== maischat.templateLembrete;
}

// Best-effort: 409 (duplicado) é tratado como sucesso lógico (já existe).
async function criarContato({ nome, celular }) {
  if (!nome || !celular) {
    console.log(`  [criarContato] PULADO — nome="${nome}" celular="${celular}"`);
    return { criado: false, motivo: "nome ou celular ausentes" };
  }
  const body = { name: nome, type: "pf", celular };
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
    if (status === 409) return { criado: false, jaExiste: true };
    return { criado: false, motivo: respData?.message || err.message };
  }
}

module.exports = {
  enviarMaisChat,
  montarPayloadTemplate,
  templateIncluiDescricao,
  criarContato,
};
