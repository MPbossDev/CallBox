# CallBox

Aplicativo simples de chamadas de voz + compartilhamento de tela para **2 ou 3 pessoas**, inspirado no Discord, mas muito mais enxuto.

- Voz em tempo real via **WebRTC** (peer-to-peer, sem passar áudio pelo servidor)
- Compartilhamento de tela com o seletor nativo do Windows
- Salas com código curto, sem login, sem cadastro, sem banco de dados
- Cliente desktop em **Electron** (HTML/CSS/JS puro)
- Servidor de sinalização em **Node.js + Socket.IO**

---

## 1. Requisitos

- [Node.js](https://nodejs.org) 18 ou superior
- Windows (o app foi pensado para gerar um `.exe`, mas roda em qualquer SO com Node/Electron)
- Internet (para o STUN público e para conectar ao servidor de sinalização)

---

## 2. Estrutura do projeto

```text
callbox/
│
├── client/
│   ├── index.html      # telas: início, nome, chamada
│   ├── style.css        # tema escuro
│   └── app.js           # sockets + WebRTC + controles
│
├── server/
│   └── server.js         # servidor Node + Socket.IO (sinalização)
│
├── electron/
│   └── main.js           # processo principal do Electron
│
├── package.json
├── README.md
└── .gitignore
```

---

## 3. Instalação

Na pasta do projeto:

```bash
npm install
```

---

## 4. Executar em desenvolvimento

```bash
npm run dev
```

Isso inicia o **servidor de sinalização** (`localhost:3000`) e abre o **Electron** ao mesmo tempo.

Se preferir rodar cada parte manualmente, em dois terminais:

```bash
npm run server   # terminal 1
npm run app      # terminal 2
```

Por padrão, o cliente se conecta em `http://localhost:3000`. Isso pode ser trocado na tela inicial, no link **"Endereço do servidor"**.

---

## 5. Como usar

1. Abra o aplicativo.
2. Clique em **"Criar nova sala"** (gera um código, ex: `A7K29X`) ou digite um código existente e clique em **"Entrar na sala"**.
3. Informe seu nome.
4. Se você criou a sala, o código já é copiado automaticamente — envie para os amigos.
5. Quando todos entrarem, o microfone já estará ativo.
6. Use os botões na parte de baixo: **Mudo**, **Tela**, **Sala** (copiar código) e **Sair**.

---

## 6. Testar com 2 ou 3 pessoas

### No mesmo computador (mais rápido para testar sozinho)

Como o app não usa trava de instância única, você pode abrir várias janelas do CallBox no mesmo PC:

```bash
npm run app
```

Rode esse comando em **dois ou três terminais diferentes** (com o servidor já rodando via `npm run server` em outro terminal, ou use `npm run dev` para o primeiro e `npm run app` para os demais). Cada janela é um "participante" separado — entre com nomes diferentes na mesma sala.

> Se notar problemas de eco, use fones de ouvido ou abaixe o volume, já que o microfone de uma janela pode captar o áudio da outra.

### Em computadores diferentes na mesma rede (Wi-Fi/rede local)

1. Descubra o IP local da máquina que vai rodar o servidor (`ipconfig` no Windows, procure por "Endereço IPv4", ex: `192.168.0.10`).
2. Nessa máquina, rode `npm run server`.
3. Nas outras máquinas, abra o CallBox, vá em **"Endereço do servidor"** e coloque `http://192.168.0.10:3000`.
4. Libere a porta 3000 no firewall do Windows caso ela bloqueie a conexão.
5. Entre na mesma sala pelos dois PCs.

### Pela internet (computadores em redes diferentes)

Hospede o servidor (veja a seção 8) e configure o **"Endereço do servidor"** de cada participante para a URL pública, por exemplo `https://callbox-server.onrender.com`.

---

## 7. Gerar o instalador `.exe`

```bash
npm run build
```

O instalador é gerado em:

```text
dist/CallBox Setup <versão>.exe
```

Esse `.exe` empacota apenas o **cliente Electron**. O servidor de sinalização precisa estar rodando em algum lugar (seu PC na rede local, ou hospedado na internet — seção 8) para que o app funcione.

---

## 8. Hospedar o servidor de sinalização (para usar entre casas diferentes)

Você não precisa deixar seu computador ligado. O `server/server.js` é um servidor Node.js comum e pode ser hospedado gratuitamente. Opções simples e compatíveis com WebSocket:

- **[Render.com](https://render.com)** — plano gratuito de "Web Service" com suporte a WebSocket. Basta conectar o repositório do GitHub, definir o *start command* como `node server/server.js` e o *build command* como `npm install`. Ele "dorme" depois de um tempo sem uso, então a primeira conexão do dia pode demorar alguns segundos.
- **[Railway](https://railway.app)** — também suporta WebSocket nativamente, com um pequeno plano gratuito/de créditos.
- **[Fly.io](https://fly.io)** — bom para long-running WebSocket, também com camada gratuita limitada.

Passos gerais (usando Render como exemplo):

1. Suba a pasta `callbox` para um repositório no GitHub.
2. No Render, crie um **Web Service** apontando para esse repositório.
3. Build command: `npm install`
4. Start command: `node server/server.js`
5. Após o deploy, você receberá uma URL tipo `https://callbox-xxxx.onrender.com`.
6. Em cada cliente CallBox, coloque essa URL no campo **"Endereço do servidor"**.

> Evite hospedagens somente de arquivos estáticos (como GitHub Pages ou Netlify sem funções) — elas não mantêm conexões WebSocket abertas, que é o que o Socket.IO precisa.

---

## 9. Sobre o STUN/TURN (limitações de rede)

O projeto usa apenas um servidor **STUN** público do Google:

```js
{ urls: "stun:stun.l.google.com:19302" }
```

Isso é suficiente para a maioria das redes domésticas. Porém, redes muito restritivas (algumas redes corporativas, universitárias ou com NAT simétrico) podem **bloquear conexões diretas P2P**. Nesses casos, a chamada pode não conectar mesmo com a sinalização funcionando.

A solução definitiva seria adicionar um **servidor TURN**, que retransmite a mídia quando a conexão direta não é possível. Isso foi propositalmente deixado de fora deste protótipo para manter o projeto simples — mas pode ser adicionado depois com serviços como [metered.ca](https://www.metered.ca/tools/openrelay/) (tem um TURN gratuito) ou rodando seu próprio [coturn](https://github.com/coturn/coturn).

---

## 10. Problemas comuns

| Problema | Causa provável | Solução |
|---|---|---|
| "Não foi possível acessar seu microfone." | Nenhum microfone conectado | Verifique se há um microfone instalado no Windows |
| "Permita o acesso ao microfone nas configurações do Windows." | Permissão negada pelo sistema | Vá em Configurações → Privacidade → Microfone e libere para o app |
| "Essa sala já possui 3 pessoas." | Sala já está no limite (3 usuários) | Peça para criarem outra sala, ou aguarde alguém sair |
| "Não foi possível conectar ao servidor." | Servidor de sinalização offline ou URL errada | Confirme se `npm run server` está rodando e se o endereço em "Endereço do servidor" está correto |
| "Conexão perdida. Tentando reconectar..." | Rede instável ou servidor caiu | O Socket.IO tenta reconectar sozinho; se persistir, reinicie o app |
| Áudio não chega entre dois participantes | Rede restritiva bloqueando WebRTC (sem TURN) | Veja a seção 9 sobre TURN |
| Compartilhamento de tela não abre o seletor do Windows | Versão do Electron/Windows sem suporte ao seletor nativo | Atualize o Windows para uma versão 10 (2004+) ou 11; em versões antigas, o Electron usa a lista de janelas do próprio Chromium como alternativa |
| Duas janelas do app no mesmo PC brigando pelo microfone | O SO só entrega o microfone físico a uma aplicação de cada vez em alguns drivers | Use fones/microfones diferentes por janela, ou teste com 2-3 PCs reais/máquinas virtuais |

---

## 11. Checklist do que já funciona

- [x] O Electron abre
- [x] Definir nome de usuário
- [x] Criar sala com código gerado automaticamente
- [x] Entrar em sala por código
- [x] Até 3 usuários por sala, 4º é bloqueado
- [x] Microfone (ativar/mutar) via WebRTC
- [x] Compartilhamento de tela (iniciar/parar) via WebRTC
- [x] Indicação visual de quem está falando, mudo e compartilhando
- [x] Saída da chamada e limpeza de conexões ao desconectar
- [x] Build para `.exe` via `electron-builder`
