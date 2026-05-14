const axios = require("axios");
const { maischat } = require("../config");

async function enviarMaisChat(body) {
  return axios.post(
    `${maischat.baseUrl}/template/send/${maischat.broker}`,
    body,
    { headers: { "Content-Type": "application/json", authorization: `Bearer ${maischat.token}` } }
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

module.exports = {
  enviarMaisChat,
  montarPayloadTemplate,
  templateIncluiDescricao,
};
