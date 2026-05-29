# api-clinica-vidas

API Node.js que integra **MdMed** (sistema de agendamentos da Clínica Vidas) e **MaisChat** (plataforma de envio de templates WhatsApp Business). Automatiza a confirmação de consultas, atende webhooks de resposta do paciente (confirmar/cancelar) e mantém a base de contatos da MaisChat sincronizada com os pacientes da MdMed.

---

## Sumário

- [Stack](#stack)
- [Arquitetura](#arquitetura)
- [Fluxos](#fluxos)
  - [Fluxo de confirmação (lote)](#fluxo-de-confirmação-lote)
  - [Fluxo de resposta (webhook)](#fluxo-de-resposta-webhook)
  - [Fluxo de sincronização de contatos](#fluxo-de-sincronização-de-contatos)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Estrutura de pastas](#estrutura-de-pastas)
- [Endpoints](#endpoints)
- [Algoritmos chave](#algoritmos-chave)
  - [Resolução de paciente por telefone](#resolução-de-paciente-por-telefone)
  - [Escolha de agendamento alvo](#escolha-de-agendamento-alvo)
  - [Normalização de celular](#normalização-de-celular)
- [Crons](#crons)
- [Cache anti-duplicação](#cache-anti-duplicação)
- [Sincronização de contatos na MaisChat](#sincronização-de-contatos-na-maischat)
- [Deploy (EasyPanel)](#deploy-easypanel)
- [Desenvolvimento local](#desenvolvimento-local)
- [Troubleshooting](#troubleshooting)
- [Runbook de operação](#runbook-de-operação)

---

## Stack

| Componente | Versão | Papel |
|---|---|---|
| Node.js | 22 (full image) | Runtime; `node:22` traz `tzdata` necessário para o cron |
| Express | 5 | HTTP server |
| axios | 1.x | Cliente HTTP para MdMed e MaisChat |
| node-cron | 4.x | Agendamento de lotes diários (API nova: `cron.schedule(expr, fn, { timezone })`) |
| dotenv | 17.x | Carregamento de envs em dev |
| nodemon (dev) | 3.x | Reload em mudanças |

**Sem banco de dados.** Estado persistido em arquivo JSON local: [src/cache.js](src/cache.js).

---

## Arquitetura

```
                  Paciente (WhatsApp)
                         |
                         | clica "Confirmar/Cancelar"
                         v
                    Bot MaisChat
                         |
       webhook chamando /agendamento/{confirmar|cancelar}-mais-recente
                         |
                         v
        +----------------------------------+
        |     api-clinica-vidas (este)     |
        |                                  |
        |  Express + Crons (node-cron)     |
        |                                  |
        |  +----------+    +-------------+ |
        |  | MdMed    |    | MaisChat    | |
        |  | client   |    | client      | |
        |  +----------+    +-------------+ |
        |        |               |         |
        |        |   +-------+   |         |
        |        |   | cache |   |         |
        |        |   | lote  |   |         |
        |        |   +-------+   |         |
        +--------|---------------|---------+
                 |               |
                 v               v
           MdMed REST       MaisChat REST
           (agendamentos)   (templates, contatos)
                                 |
                                 v
                          Meta WhatsApp Cloud
```

A API roda como container Docker simples (sem orquestração) atrás do EasyPanel/Traefik. O cache de dedup vive em volume persistente montado em `/app/data`.

---

## Fluxos

### Fluxo de confirmação (lote)

Disparado pelo cron diário (default 08h BRT) ou por `POST /agendamento/enviar-confirmacoes`.

```
1.  GET /appointment?date=YYYY-MM-DD              (MdMed, paginado)
2.  filtra status=Agendado && patient_phone != null
3.  filtra fora codes já em cache "confirmacao:YYYY-MM-DD"
4.  para cada agendamento elegível:
       POST /template/send/wppCloudAPI          (MaisChat → Meta)
       marcarEnviadoNoLote("confirmacao", date, code)
       push em "enviados" com patient_name
5.  fase de sincronização (apenas confirmação):
       deduplica enviados por (celular+nome)
       para cada item:
           POST /contact                         (MaisChat)
           se 409 -> extrai id ou GET /contact/cellphone/{x}
                  -> PATCH /contact/{id}         (MaisChat)
6.  retorna sumário (totais + bloco "contatos")
```

**Response típico:**

```json
{
  "sucesso": true,
  "tipo": "confirmacao",
  "template": "confirma_agendamento_4",
  "date": "2026-05-26",
  "supplierId": null,
  "supplierName": null,
  "total": 62,
  "totalElegiveis": 58,
  "totalJaProcessados": 0,
  "totalSemTelefone": 0,
  "totalEnviados": 58,
  "totalFalhas": 0,
  "enviados": [
    { "code": 58602092, "destination": "5547999000000", "data": "26/05/2026", "horario": "08:15", "msgId": "...", "patient_name": "..." }
  ],
  "falhas": [],
  "semTelefone": [],
  "contatos": {
    "criados": 12,
    "atualizados": 40,
    "jaExistiam": 0,
    "falhas": 6,
    "detalhes": [{ "nome": "...", "celular": "...", "motivo": "..." }]
  }
}
```

### Fluxo de resposta (webhook)

O bot MaisChat chama `POST /agendamento/{confirmar|cancelar}-mais-recente` quando o paciente reage à mensagem.

```
1.  resolverPacienteComData({ phone, patientId, cpf, dataYMD })
       a) buscarPacientesPorTelefone(phone)       (MdMed /patient)
       b) se único -> ok
       c) se múltiplos:
           - se vier patientId/cpf -> filtra
           - se vier dataYMD -> filtra por data exata
           - sem nada -> cruza com cache de envios; senão usa janela
2.  se ok && multiplos:
       processa todos os agendamentos da família (loop)
       retorna { sucesso: true, familia: true, resultados: [...] }
3.  se ok && único:
       listarAgendamentosPaginado({ patientId })
       escolherAgendamento(...)
       mudarStatusAgendamento({ ag, novoStatus })  (MdMed PUT)
4.  retorna paciente + agendamento (nome, data, horário, descrição)
```

**Response típico (sucesso):**

```json
{
  "sucesso": true,
  "mensagem": "Agendamento confirmado.",
  "paciente": { "code": 12345, "name": "JOÃO DA SILVA", "phone": "...", "cpf": "..." },
  "agendamento": {
    "code": 58602092,
    "status": "Confirmado",
    "start_datetime": "2026-05-26T08:15:00",
    "data": "26/05/2026",
    "horario": "08:15",
    "description": "CONSULTA CARDIOLOGIA"
  }
}
```

**Códigos de erro do webhook:**

| Status | Cenário |
|---|---|
| `400` | `NumeroCelular` ausente, `DataAgendamento` em formato inválido |
| `404` | Paciente não encontrado / nenhum agendamento elegível |
| `409` | Telefone com múltiplos pacientes (precisa de `patientId`/`cpf`) ou múltiplos agendamentos elegíveis (precisa de `DataAgendamento`) ou tentativa de reconfirmar um cancelado |
| `502` | Erro retornado pela MdMed ao mudar status |

**Resposta de família (mesmo telefone, vários pacientes):**

```json
{
  "sucesso": true,
  "familia": true,
  "mensagem": "2 de 2 agendamentos com status 'Confirmado'.",
  "criterio": "data=2026-05-24",
  "resultados": [
    { "paciente": { "code": 1, "name": "MÃE" },  "sucesso": true, "agendamento": {...} },
    { "paciente": { "code": 2, "name": "FILHO" }, "sucesso": true, "agendamento": {...} }
  ]
}
```

### Fluxo de sincronização de contatos

`POST /contatos/sincronizar` executa o passo 5 do lote isoladamente, varrendo todos os agendamentos do dia (ou data passada no body).

Útil para:
- Backfill: popular nomes em contatos que o WhatsApp Business cadastrou automaticamente
- Pré-aquecimento da base antes de um disparo manual
- Operação one-off sem precisar enviar templates

---

## Variáveis de ambiente

Template completo em [.env.example](.env.example). Detalhamento:

### Obrigatórias

| Var | Descrição |
|---|---|
| `MDMED_BASE_URL` | URL base da API MdMed (ex: `https://apil.mdmed.clinic/api/v1`) |
| `MDMED_TOKEN` | Bearer token MdMed (`Authorization: Bearer <token>`) |
| `MAISCHAT_BASE_URL` | URL base MaisChat (ex: `https://api.maischat.io/v3`) |
| `MAISCHAT_TOKEN` | Bearer token MaisChat (JWT do tenant) |
| `MAISCHAT_BROKER` | Broker (ex: `wppCloudAPI`) |
| `MAISCHAT_APP_ID` | App ID Meta WhatsApp Business |
| `MAISCHAT_SOURCE` | Número remetente WhatsApp (ex: `554733572231`) |
| `MAISCHAT_META_TOKEN` | Token Meta com acesso direto ao WhatsApp Cloud API |
| `MAISCHAT_TEMPLATE_NAME` | Nome do template de confirmação (4 vars) aprovado na Meta |

### Configuração

| Var | Default | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `TIMEZONE` | `America/Sao_Paulo` | Timezone para cron e formatação |
| `MAISCHAT_TEMPLATE_LANGUAGE` | `pt_BR` | Idioma do template Meta |
| `MAISCHAT_DEFAULT_COUNTRY_CODE` | `55` | DDI default |
| `MDMED_TIMEOUT_MS` / `MAISCHAT_TIMEOUT_MS` | `30000` | Timeout HTTP em ms |

### Janelas de tempo (dias)

| Var | Default | Descrição |
|---|---|---|
| `DIAS_CONFIRMACAO` | `5` | Antecedência do cron de confirmação |
| `DIAS_JANELA_RESPOSTA` | `30` | Janela usada por `escolherAgendamento` quando webhook chega sem data |
| `DIAS_AUTO_DESAMBIGUACAO` | `7` | Janela usada para escolher paciente em família |
| `DIAS_TOLERANCIA_ESCOLHA` | `2` | Tolerância em dias na busca por janela |

### Crons

| Var | Default | Descrição |
|---|---|---|
| `CRON_LOTE_EXPR` | `0 8 * * *` | Expressão (formato cron padrão) |
| `CRON_LOTE_ATIVO` | `true` | `false` desliga |

> O parser usado em [config.js](config.js) trata qualquer string diferente de `"false"` como `true`. Para desligar, **use exatamente `false`**.

### Cache

| Var | Default | Descrição |
|---|---|---|
| `CACHE_LOTE_PATH` | `./cache-lote.json` | Caminho do arquivo de dedup. **Em produção aponte para volume persistente, ex.: `/app/data/cache-lote.json`** |
| `CACHE_LOTE_RETENCAO_DIAS` | `7` | Entradas mais antigas que isso são limpas em cada `marcarEnviadoNoLote` |

---

## Estrutura de pastas

```
.
├── index.js              Bootstrap Express, rotas, registro de crons
├── config.js             Lê e normaliza envs (num/bool helpers)
├── src/
│   ├── mdmed.js          Cliente MdMed + resolução paciente/agendamento
│   ├── maischat.js       Cliente MaisChat: template + CRUD contatos
│   ├── lotes.js          executarLote() para confirmação
│   ├── cache.js          jaEnviadoNoLote/marcarEnviadoNoLote/codesNoCache
│   └── utils.js          formatação celular/data, handleError
├── app.http              Coleção de requests (REST Client VSCode)
├── Dockerfile
├── .env.example
├── nodemon.json
└── cache-lote.json       (gerado em runtime; ignorado pelo .dockerignore)
```

---

## Endpoints

Exemplos completos com `Content-Type` e variáveis em [app.http](app.http). Resumo:

### Saúde

| Método | Path | Response |
|---|---|---|
| `GET` | `/ping` | `{ "pong": true }` |
| `GET` | `/health` | `{ "status": "ok" }` |

### Listagens

| Método | Path | Descrição |
|---|---|---|
| `GET` | `/appointments?date=YYYY-MM-DD` | Agendamentos do dia (default: hoje) |
| `GET` | `/suppliers?date=YYYY-MM-DD` | Médicos no dia + totais por status (para escolher `supplierId`) |
| `GET` | `/appointments/by-phone?phone=...&patientId=...&cpf=...` | Agendamentos de um paciente |

### Paciente

| Método | Path | Body | Descrição |
|---|---|---|---|
| `POST` | `/paciente/celular` | `{ NumeroCelular, patientId?, cpf? }` | Busca paciente, com desambiguação opcional |

### Envio individual

| Método | Path | Descrição |
|---|---|---|
| `POST` | `/agendamento/enviar-confirmacao` | Envia template para 1 paciente. Sincroniza contato após sucesso. |

Body:
```json
{
  "NumeroCelular": "554799000000",
  "DataAgendamento": "2026-05-24",
  "template": "confirma_agendamento_4",
  "diasAntes": 5,
  "patientId": 12345,
  "cpf": "12345678900"
}
```

### Envio em lote (cron)

| Método | Path | Descrição |
|---|---|---|
| `POST` | `/agendamento/enviar-confirmacoes` | Lote de confirmação. Sincroniza contatos depois. |

Body opcional:
```json
{
  "DataAgendamento": "2026-05-26",
  "diasAntes": 5,
  "supplierId": 1574964
}
```

Sem body → dispara para `hoje + DIAS_CONFIRMACAO`.

### Mudança de status (webhook)

| Método | Path | Descrição |
|---|---|---|
| `POST` | `/agendamento/confirmar-mais-recente` | Status → `Confirmado` |
| `POST` | `/agendamento/cancelar-mais-recente` | Status → `Cancelado` |

Body:
```json
{
  "NumeroCelular": "554799000000",
  "DataAgendamento": "2026-05-24",
  "diasAntes": 30,
  "patientId": 12345,
  "cpf": "12345678900"
}
```

`DataAgendamento` é opcional mas recomendado para evitar ambiguidade em famílias.

### Sincronização de contatos

| Método | Path | Body opcional | Descrição |
|---|---|---|---|
| `POST` | `/contatos/sincronizar` | `{ date?, supplierId? }` | Cria/atualiza contatos MaisChat a partir dos agendamentos |

### Teste

| Método | Path | Descrição |
|---|---|---|
| `POST` | `/test/whatsapp` | Envia template com dados fake (não sincroniza contato) |

---

## Algoritmos chave

### Resolução de paciente por telefone

`buscarPacientesPorTelefone` em [src/mdmed.js](src/mdmed.js) busca o paciente na MdMed gerando **variantes** do telefone (com/sem DDI, com/sem 9), porque os cadastros não seguem um padrão único. Para um número `5547999000000`:

```
Variantes geradas:
  47999000000        (sem DDI, com 9)
  47900000000        (sem DDI, sem 9 — só se número tem 9 dígitos)
  5547999000000      (com DDI, com 9)
  554700000000       (com DDI, sem 9)
```

A função consulta `/patient?phone_number=` para cada variante e deduplica por `code`.

### Escolha de agendamento alvo

`escolherAgendamento` em [src/mdmed.js](src/mdmed.js) decide qual agendamento o webhook deve confirmar/cancelar:

```
input: lista de agendamentos do paciente, { data?, diasAntes?, tolerancia? }

1. Se data passada:
     pool = agendamentos com start_datetime começando com YYYY-MM-DD
   Senão:
     fim = hoje + diasAntes + tolerancia
     pool = agendamentos com data entre [hoje, fim], ordenados ascendente

2. Filtra pool por status=Agendado:
     se exatamente 1 -> retorna ele
     se >1 -> retorna ambiguidade (precisa DataAgendamento)
     se 0 (todos Confirmado/Cancelado):
        se pool.length == 1 -> retorna ele
        senão -> ambiguidade
```

Isso permite que o paciente confirme um agendamento já confirmado (idempotente) ou cancele um confirmado, mas bloqueia múltiplos agendamentos em janelas semelhantes.

### Normalização de celular

Três formatos coexistem no fluxo:

| Função | Input | Output | Onde é usada |
|---|---|---|---|
| `formatarCelular` ([src/utils.js](src/utils.js)) | qualquer | DDI + número (13 dígitos típicos) | Antes de enviar template (`destination`) |
| `normalizarCelularParaContato` ([src/maischat.js](src/maischat.js)) | qualquer | sem DDI (10–11 dígitos) | Body do `POST /contact` — MaisChat espera sem DDI |
| `variantesTelefoneMdmed` ([src/utils.js](src/utils.js)) | qualquer | array de 4 variações | Busca de paciente na MdMed |

A MaisChat retira o "9" do meio se for enviado com DDI; por isso o `POST /contact` é feito **sem o 55** (apenas DDD + número de 11 dígitos).

---

## Crons

Um job registrado em [index.js](index.js) com `node-cron@4.x`:

```js
cron.schedule(expr, async () => { ... }, { timezone: "America/Sao_Paulo" });
```

No boot, o stdout mostra:

```
[Cron] Confirmação ATIVA: "0 8 * * *" (TZ America/Sao_Paulo, 5 dias antes, status=Agendado, template=...)
Servidor rodando em http://localhost:3002
```

Se em vez disso aparecer `DESATIVADA`, a env `CRON_LOTE_ATIVO=false` está sendo lida.

Para verificar se o cron disparou, procure no log por linhas começando com `[Cron confirmacao]`:

```
[26/05/2026, 08:00:00] [Cron confirmacao] Disparando lote...
[Cron confirmacao] template=confirma_agendamento_4 date=2026-05-31 total=62 elegiveis=58 jaProcessados=0 semTelefone=0 enviados=58 falhas=0
```

---

## Cache anti-duplicação

Persistido em JSON simples:

```json
{
  "confirmacao:2026-05-26": [58602092, 58602137, 58602234]
}
```

Operações (em [src/cache.js](src/cache.js)):

- `jaEnviadoNoLote(tipo, data, code)` → `boolean`
- `marcarEnviadoNoLote(tipo, data, code)` → adiciona + faz purge de entradas com data anterior a `hoje - CACHE_LOTE_RETENCAO_DIAS`
- `codesNoCache(["confirmacao"])` → `Set<code>` usado para desambiguar família

**Migração de chaves antigas:** o arquivo aceita chaves só com data (formato antigo, sem `tipo:`) e migra para `confirmacao:data` em `lerCacheLote()`.

**Persistência:** sem volume montado, o arquivo vive no filesystem efêmero do container e o cache zera a cada redeploy. **Configure `CACHE_LOTE_PATH=/app/data/cache-lote.json`** com volume `cache-data` montado em `/app/data`.

---

## Sincronização de contatos na MaisChat

`criarContato({ nome, celular })` em [src/maischat.js](src/maischat.js) implementa create-or-update:

```
1. normaliza celular para 10-11 dígitos (remove DDI)
2. valida tamanho (10 ou 11); senão registra "PULADO"
3. POST /contact { name, type:"pf", celular }
4. Sucesso (201) -> retorna { criado: true, contato }
5. Erro 409 (já existe):
      a. extrai id do body de erro (data._id ou data.id)
      b. se não houver -> GET /contact/cellphone/{celular} -> pega id
      c. PATCH /contact/{id} { name }
      d. retorna { atualizado: true, contato }
6. Outro erro -> retorna { criado: false, motivo }
```

**Rate limit:** docs MaisChat indicam 15 req / 5s para `/contact` e `/contact/{id}`. No pior caso (todos já existem) cada item consome 3 requests (POST → GET → PATCH). Para 60 contatos = 180 requests, levaria ~60s respeitando o limit. **Atualmente não há throttle no código.** Se houver erro 429, considerar adicionar `await sleep(200)` entre as chamadas.

**Logs `[criarContato]`, `[atualizarContato]` e `[buscarContatoPorCelular]`** — todos imprimem status e body completo da resposta para diagnóstico.

---

## Deploy (EasyPanel)

**Configuração esperada:**

| Campo | Valor |
|---|---|
| Source | GitHub (`JoVic-C/api-clinica-vidas`, branch `master`) |
| Build | Dockerfile |
| Porta interna | `3002` (igual `PORT` env) |
| Volume | `cache-data` montado em `/app/data` |
| Env `CACHE_LOTE_PATH` | `/app/data/cache-lote.json` |

**Domínio:** o `internalProtocol` é `http`; o EasyPanel/Traefik termina TLS no `host` configurado (ex: `outros-maischat-api-clinicavidas.xxx.easypanel.host`).

**Pós-deploy** — verifique nos primeiros logs:

1. `[Cron] Confirmação ATIVA: ...`
2. `Servidor rodando em http://localhost:3002`
3. `GET /ping` retorna 200

---

## Desenvolvimento local

```bash
git clone https://github.com/JoVic-C/api-clinica-vidas.git
cd api-clinica-vidas
cp .env.example .env       # edite os tokens
npm install
npm run dev                # nodemon
# ou
npm start
```

Recomendado em dev:

```
CRON_LOTE_ATIVO=false
```

Para testar requests, abra [app.http](app.http) no VSCode com a extensão **REST Client**. Há exemplos prontos para todos os endpoints, incluindo casos de erro.

---

## Troubleshooting

### Cron não disparou

1. **Verifique startup log**: `[Cron] Confirmação ATIVA: ...` deve aparecer. Se `DESATIVADA`, a env `CRON_LOTE_ATIVO=false` foi lida.
2. **Confirme o horário**: default `0 8 * * *` = todo dia às 08:00 BRT. Se você esperou em outro horário, ele só dispara amanhã.
3. **Container reiniciado depois das 8h**: o cron registrado pela instância anterior morreu junto. A nova instância só vai disparar no próximo agendamento.
4. **Validar timezone**: `node:22-alpine` exige `tzdata`; o Dockerfile atual usa `node:22` (full), que já traz.
5. **Disparo manual de teste**: `POST /agendamento/enviar-confirmacoes` com body `{}`. Se funcionar, é problema só com o agendamento.

### Contato salvo só com telefone (sem nome)

Quando o canal WhatsApp Business cadastra automaticamente o contato no momento que o template chega, ele usa só o telefone como nome. Para corrigir:

1. `POST /contatos/sincronizar` — varre os agendamentos do dia e atualiza nomes
2. Confira o log `[atualizarContato] OK id=... status=200` — significa que o PATCH funcionou

Se aparecer `[criarContato] PULADO` no log:
- `nome ou celular ausentes` → o agendamento no MdMed não tem `patient_name` ou `patient_phone`
- `celular fora do padrão BR (10/11 dígitos)` → telefone inválido depois de normalizar (ex: 5512345 só com DDD ou número internacional)

### "Múltiplos agendamentos elegíveis"

O webhook chegou sem `DataAgendamento` e o paciente tem mais de um agendamento na janela `DIAS_JANELA_RESPOSTA`. Configure o bot MaisChat para sempre enviar `DataAgendamento` (extraído do template ou variável do fluxo).

### "Mais de um paciente com este telefone"

Família compartilha o telefone. O bot precisa enviar `patientId` (preferencial) ou `cpf` para desambiguar, ou pelo menos `DataAgendamento` (a API tenta desambiguar cruzando cache de envios).

### Contato existe mas PATCH falha

Veja `[atualizarContato] ERRO id=... status=...` no log:
- `404` → o id extraído do 409 ou do GET está errado (improvável)
- `429` → rate limit MaisChat. Pause o disparo, espere 5s e tente de novo

### Cache zera a cada redeploy

Falta configurar o volume `/app/data` + a env `CACHE_LOTE_PATH=/app/data/cache-lote.json`. Sem isso, dedup é perdida e pacientes podem receber template duplicado.

---

## Runbook de operação

### Disparar lote manualmente (uma data específica)

```http
POST {{host}}/agendamento/enviar-confirmacoes
Content-Type: application/json

{ "DataAgendamento": "2026-05-26" }
```

### Disparar lote só para um médico

```http
POST {{host}}/agendamento/enviar-confirmacoes
{ "DataAgendamento": "2026-05-26", "supplierId": 1574964 }
```

Use `GET /suppliers?date=2026-05-26` antes para descobrir o `supplierId`.

### Reenviar para um paciente específico

```http
POST {{host}}/agendamento/enviar-confirmacao
{ "NumeroCelular": "554799000000", "DataAgendamento": "2026-05-26" }
```

Atenção: **isso ignora o cache**, ou seja, pode duplicar se o paciente já recebeu no lote.

### Forçar reenvio limpando o cache

Edite o arquivo `cache-lote.json` no volume `/app/data` e remova a entrada da data alvo. Ou apague o arquivo inteiro (o código recria vazio).

```bash
# dentro do container
rm /app/data/cache-lote.json
# ou cirurgicamente
jq 'del(."confirmacao:2026-05-26")' /app/data/cache-lote.json > /tmp/x && mv /tmp/x /app/data/cache-lote.json
```

### Backfill de contatos

```http
POST {{host}}/contatos/sincronizar
{ "date": "2026-05-26" }
```

Útil após adicionar a integração de contatos pela primeira vez, ou após corrigir nomes na MdMed.

### Rotacionar tokens

1. Gere o novo token na fonte (MdMed admin / MaisChat painel / Meta Business Manager)
2. Atualize a env correspondente no EasyPanel
3. Redeploy
4. Confirme o `GET /ping` e dispare um `POST /test/whatsapp` para validar

Tokens sensíveis:
- `MAISCHAT_META_TOKEN` — acesso direto ao WhatsApp Cloud API (rotacione com prioridade se vazar)
- `MAISCHAT_TOKEN` — tenant da MaisChat
- `MDMED_TOKEN` — acesso à base de pacientes

### Métricas a monitorar

| Sinal | Onde olhar | O que significa |
|---|---|---|
| `totalFalhas > 0` no response do lote | `falhas[]` no JSON | Template rejeitado pela Meta, paciente sem opt-in, etc. |
| `[Cron ...] erro:` no log | stdout | Exceção na execução do cron |
| `[criarContato] ERRO` recorrente fora de 409 | stdout | Algo errado com endpoint/auth MaisChat |
| `totalSemTelefone > 0` | response do lote | Agendamentos sem `patient_phone` no MdMed — corrigir no cadastro |
| `429` em qualquer chamada | log axios | Rate limit; adicionar throttle |
