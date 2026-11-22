# Sync TV

Toca o mesmo vídeo do YouTube em duas ou mais TVs ao mesmo tempo, sincronizadas, com controle pelo celular. É um site estático (GitHub Pages): não precisa de servidor próprio.

- **TV:** `https://perissatto.github.io/sync-tv/tv`, aberto no navegador da LG (webOS).
- **Celular:** `https://perissatto.github.io/sync-tv/`

## Primeiro uso

1. Em cada TV, abra o **Navegador da Web**, entre em **youtube.com** e faça login com a conta Premium (é isso que tira os anúncios). Depois acesse `perissatto.github.io/sync-tv/tv` e salve nos favoritos.
2. A TV mostra um **código de 6 dígitos**. No celular, abra o app, toque em **+ Adicionar TV**, digite o código e dê um nome (Sala, Varanda…). Se preferir, aponte a câmera do celular para o QR da TV.
3. Na TV, aperte **OK** no controle para ativar. O navegador exige um clique antes de tocar vídeo com som.
4. No celular, cole um link do YouTube e toque em **Tocar agora**.

Repita o passo 2 para cada TV. Todas ficam na mesma "sala".

## Como funciona

- **Sincronização:** as mensagens passam por um broker MQTT público via WebSocket (HiveMQ, com o EMQX como alternativa).
- **TV principal:** uma TV é eleita automaticamente como líder. Ela recebe os comandos e define a linha do tempo (vídeo, posição e instante de início).
- **Relógio:** as outras TVs medem a diferença de relógio para a líder, no estilo NTP (ping/pong, guardando a amostra de menor latência).
- **Correção do atraso:** diferenças pequenas são corrigidas com rajadas curtas de velocidade 1,25×/0,75×, e as grandes com *seek*. A TV aprende sozinha quanto o player demora para "pegar" depois de um seek.
- **Troca de líder:** se a líder for desligada, outra assume em cerca de 4 s sem parar o vídeo.

Em teste com relógios desencontrados em ±3 s, latência de rede aleatória de até 250 ms e uma TV tocando 0,2% mais rápido, a diferença entre as TVs ficou em 20 a 50 ms.

## Limitações

- Vídeos em que o dono **bloqueou a incorporação** (comum em clipes de gravadoras) não tocam fora do YouTube. A TV mostra o aviso e pula para o próximo da fila.
- Transmissões ao vivo funcionam, mas a sincronia fina não é garantida.
- O broker é público: quem souber o código da sala consegue controlar e ver o que está tocando. Não divulgue o código. Dá para criar uma sala nova no celular quando quiser.

## Diagnóstico

Aperte qualquer tecla no controle da TV para ver a barra de status: conexão, papel da TV, diferença em ms e latência. No celular, a lista de TVs mostra a diferença de cada uma em relação à principal.
