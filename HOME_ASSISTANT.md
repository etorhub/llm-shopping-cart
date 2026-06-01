# Integració amb Home Assistant (Assist + veu)

Objectiu: un sol agent de veu que controla la casa I fa la compra a Bonpreu.

## Com encaixa

```
  Voice PE / Atom  --(veu)-->  HA Assist (STT)
                                   |
                          Agent de conversa LLM
                          (Claude / OpenAI / local)
                           |                  |
                     Assist API          MCP Client (SSE)
                  (llums, sensors...)         |
                                       servidor del NAS
                                       GET /sse  -> tools de Bonpreu
                                   search_items / add_to_cart / update_orders
```

La integració MCP Client de HA NO crea un agent separat: afegeix les tools del
teu servidor al conjunt de tools disponibles per a l'agent de conversa, al
costat de l'Assist API. Així el mateix agent pot encendre llums i afegir coses
al cistell.

## Requisit de transport: SSE

HA parla el transport SSE (no Streamable HTTP). El servidor ja exposa:
- `GET  /sse`        -> obre l'stream (HA s'hi connecta aquí)
- `POST /messages`   -> el client hi envia les peticions (HA ho fa sol)

L'URL que configuraràs a HA acaba en `/sse`.

## Passos a Home Assistant

1. **Tria un agent de conversa LLM** i instal·la'n la integració:
   - Claude (Anthropic) o OpenAI: function calling molt fiable (recomanat per
     a la compra, on un error afegeix el producte equivocat al cistell real).
   - Local (Ollama/llama.cpp): tot a casa, sense cost ni núvol, però el
     function calling depèn molt del model; usa'n un de prou competent.
   El MCP del NAS és independent del model: pots canviar-lo després sense
   tocar res del servidor.

2. **Afegeix la integració "Model Context Protocol" (client)**:
   Configuració > Dispositius i serveis > Afegeix integració > "Model Context
   Protocol". Posa l'URL SSE del NAS:
       http://NAS_IP:8080/sse
   Si has activat OAuth al servidor, introdueix el Client Secret a les
   Credencials d'aplicació quan t'ho demani.

3. **Activa les tools a l'agent**: a la configuració de l'agent de conversa,
   assegura't que té accés tant a l'Assist API (control de la casa) com a la
   nova LLM API que crea el MCP Client (les tools de Bonpreu).

4. **Assigna l'agent a Assist** i al teu hardware de veu (Voice PE / Atom):
   Configuració > Veu (Assist) > Pipeline -> tria l'agent de conversa, STT i
   TTS. Assigna el pipeline al dispositiu de veu.

## Prompt de l'agent (suggeriment)

Afegeix alguna cosa així al prompt del sistema de l'agent, perquè usi bé les
tools de la compra:

  Tens accés a tools per gestionar la compra a Bonpreu. Quan l'usuari demani
  afegir productes a la compra/cistell, fes servir add_to_cart amb els noms
  dels productes. Els productes es comparen amb l'historial de comandes, així
  que només coincidiran coses que ja ha comprat abans. Confirma sempre què
  s'ha afegit. Si l'usuari només vol veure coincidències sense afegir res, usa
  search_items. No facis cap pagament ni checkout: tu només omples el cistell.

## Prova

Amb el dispositiu de veu: "afegeix llet i ous a la compra". L'agent hauria de
cridar add_to_cart, i ho pots verificar obrint el cistell a
compraonline.bonpreuesclat.cat. El checkout i el pagament els fas tu a mà.

## Notes

- La sessió de Bonpreu caduca en ~5-7 dies: quan add_to_cart comenci a fallar,
  refresca-la (login al PC + scp al NAS; veure DEPLOY_NAS.md).
- Si HA i el NAS són a la mateixa LAN, no cal exposar res a internet. Per a
  accés remot, millor VPN/Tailscale que obrir el port.
