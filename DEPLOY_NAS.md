# Desplegament al NAS (Docker)

Arquitectura:

```
  [El teu PC amb pantalla]                 [NAS]                      [Home Assistant]
   node main.js --login      --copia-->   contenidor Docker   <--MCP-- integració
   (genera session.json)     session.json  mcp-server-http.js          conversa/REST
                                           llegeix session.json
                                           POST /mcp, /api/*
```

El contenidor del NAS NOMÉS corre el servidor. El login (que necessita un
navegador) es fa al teu PC i la `session.json` resultant es copia al NAS.
Així el NAS no necessita Chromium ni pantalla.

## 1. Login al PC (una vegada, i cada ~5-7 dies quan caduqui)

Al teu PC, dins del repo:

```bash
node main.js --login --head      # obre navegador, fas login a Bonpreu
```

Això crea/actualitza `session.json` a l'arrel del repo.

## 2. Estructura de carpetes al NAS

Crea una carpeta per al desplegament al NAS, p.ex. `/volume1/docker/bonpreu-mcp/`,
i copia-hi: tot el repo (o almenys `src/`, `mcp-server-http.js`, `package*.json`,
`Dockerfile.nas`, `docker-compose.nas.yml`). Dins crea:

```
bonpreu-mcp/
  ├─ (codi del repo)
  ├─ session/
  │    └─ session.json     <- el copies des del PC
  └─ data/
       └─ orders.json      <- es genera sol al primer --update via servidor,
                               o el copies també des del PC la primera vegada
```

## 3. Copiar la sessió al NAS

Des del PC (ajusta usuari/host/ruta del teu NAS):

```bash
scp session.json    usuari@NAS:/volume1/docker/bonpreu-mcp/session/session.json
scp data/orders.json usuari@NAS:/volume1/docker/bonpreu-mcp/data/orders.json
```

Hi ha un script de conveniència: `scripts/push-session-to-nas.sh` (edita les
variables de dalt amb les dades del teu NAS).

## 4. Aixecar el contenidor al NAS

```bash
cd /volume1/docker/bonpreu-mcp
docker compose -f docker-compose.nas.yml up -d --build
docker compose -f docker-compose.nas.yml logs -f      # veure que arrenca bé
```

Comprova el health:

```bash
curl http://NAS_IP:8080/         # -> {"status":"ok","service":"ocado-mcp"}
```

## 5. (Recomanat) Activar OAuth

Sense OAuth, qualsevol a la LAN que trobi el port pot afegir coses al cistell.
Genera secrets i posa'ls al docker-compose.nas.yml (variables comentades):

```bash
openssl rand -hex 32   # per a OAUTH_CLIENT_SECRET
openssl rand -hex 32   # per a OAUTH_JWT_SECRET
```

Després `docker compose ... up -d` de nou. Ara `/mcp` i `/api/*` exigeixen un
Bearer token. Per obtenir-ne un:

```bash
curl -X POST http://NAS_IP:8080/token \
  -d grant_type=client_credentials \
  -d client_id=bonpreu-ha \
  -d client_secret=<el-teu-secret>
# -> {"access_token":"...","token_type":"Bearer","expires_in":3600}
```

## 6. Refrescar la sessió quan caduqui

Quan `update-orders` torni 0 ordres o `add-to-cart` doni 401/403, la sessió ha
caducat. Repeteix els passos 1 i 3 (login al PC + scp al NAS). No cal reiniciar
el contenidor: el servidor llegeix `session.json` a cada operació. (Si el munt
read-only et fa nosa, pots reiniciar amb `docker compose restart`.)

## Notes

- NO posis `GCS_BUCKET`: així tot queda local al NAS.
- El contenidor té `restart: unless-stopped`, sobreviu reinicis del NAS.
- Exposa el port només a la LAN. No el publiquis a internet sense OAuth (i
  idealment ni amb OAuth — millor via VPN/Tailscale si necessites accés remot).
