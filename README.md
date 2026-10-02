# opencode-autonomia

Hace que un agente de [opencode](https://opencode.ai) trabaje **solo hasta
terminar**, sin detenerse a preguntar "¿sigo con la siguiente fase?" entre
etapas, y sin que tengas que intervenir si se queda atascado.

## Instalación

```bash
curl -fsSL https://raw.githubusercontent.com/extramega1-stack/opencode-autonomy/main/opencode-autonomia.sh | bash
```

Después **reiniciá opencode**: la config se carga una sola vez al arrancar.

Para ver qué va a hacer antes de aplicarlo:

```bash
curl -fsSL https://raw.githubusercontent.com/extramega1-stack/opencode-autonomia/main/opencode-autonomia.sh | bash -s -- --dry-run
```

## Qué hace

Cuatro capas independientes. Cada una cubre un modo distinto de que el agente
se frene.

### 1. Permisos — que no aparezca el diálogo

`permission` en `allow` para lectura, edición, bash y todo lo demás. Por default
opencode pregunta por cada `bash` y eso corta el trabajo a mitad de camino.

Se mantienen denegadas las operaciones que de verdad no querés automatizar
(`rm -rf /`, `mkfs`, `curl | sh`, fork bombs…).

### 2. `doom_loop` — que no se corte en bucle

opencode ya detecta cuando el agente repite **3 llamadas idénticas seguidas** y
por default pregunta si seguir. Con `doom_loop: allow` lo resuelve solo.

`experimental.continue_loop_on_deny` complementa: un `deny` no termina el loop,
el agente busca otro camino.

### 3. Auto-continue — que no termine el turno antes de tiempo

Acá está el motor: `plugins/continuity.ts`. Cuando la sesión queda inactiva y
todavía hay tareas pendientes en la lista, el plugin se las reenvía al agente y
la sesión sigue. Corta solo cuando:

- la lista de tareas quedó vacía (terminó de verdad), o
- no avanzó en 3 intentos seguidos, o
- se agotaron los límites (`max_continues`, `max_minutes`).

El plugin también intercepta cada compactación de contexto e inyecta el estado
real del proyecto — objetivo original, tareas abiertas, `git status`, diffs,
últimos commits. Sin eso, una sesión larga se compacta a un resumen narrativo y
el objetivo se pierde en el camino.

#### El detalle que hace que funcione

La detección de stagnación compara un fingerprint entre intentos. La primera
versión hasheaba solo `HEAD` + `git status`, lo cual falla en dos casos muy
comunes:

- un directorio que **no es repo git** → git falla, el hash nunca cambia, y
  *cada* continue cuenta como stall: el plugin para todo a los dos intentos.
- un agente **leyendo o planificando** sin escribir nada todavía → el working
  tree no se movió, pero el agente sí está trabajando.

Por eso el hash son dos capas: el working tree **más** el conteo de tool calls
de la sesión. La segunda avanza siempre que el agente haga algo, incluso fuera
de un repo git.

```
old hash, no repo     #1 ok #2 stall=1 #3 stall=2 #4 STOP     ← roto
new hash, tools       #1 ok #2 ok #3 ok #4 ok #5 ok #6 ok #7 ok #8 ok
new hash, wedged      #1 ok #2 stall=1 #3 stall=2 #4 STOP     ← correcto
```

### 4. `AGENTS.md` — el contrato

Instrucciones globales que le dicen al agente qué significa "terminado":
escribir la lista completa de fases antes de empezar, una fase activa a la vez,
verificar antes de marcar como hecha, **reportar solo al final**.

Incluye también qué hacer con los errores: dos intentos fallidos con la misma
técnica → cambiar de técnica. Un error de entorno no detiene el trabajo, se
anota para el informe final.

## Qué NO rompe

El instalador **mergea**, no pisa. Tu `model`, `provider`, `mcp`, `theme` y tus
reglas de permisos propias se conservan:

```jsonc
// antes
"permission": { "read": { "*.env": "deny" } }

// después
"permission": { "read": { "*": "allow", "*.env": "deny" } }
```

Instalarlo dos veces da el mismo resultado. Y `--uninstall` devuelve tu config
al estado previo exacto.

Todo se backs upea antes de tocar nada, con sufijo de timestamp.

## Comandos

| Flag | Qué hace |
|---|---|
| (ninguno) | Instala / actualiza |
| `--dry-run` | Muestra qué haría, no escribe nada |
| `--print` | Imprime la config final y sale |
| `--uninstall` | Saca los bloques de autonomía |

## Ajustar los límites

En `~/.config/opencode/continuity.json`:

| Clave | Default | Qué es |
|---|---|---|
| `auto_continue` | `true` | El motor completo |
| `max_continues` | `2000` | Tope de reanudaciones por sesión |
| `max_minutes` | `1440` | Tope de tiempo por sesión (24h) |
| `cooldown_seconds` | `20` | Espera entre reanudaciones |
| `stall_limit` | `3` | Intentos sin avance antes de parar |

Son las únicas paradas automáticas que existen.

## Cosas que tenés que saber

- **`question: deny`** — el agente no te va a preguntar nada, decide él. Es el
  precio de la autonomía: si algo es genuinamente ambiguo, va a elegir una
  interpretación y seguir, no esperar tu respuesta.
- **El agente puede hacer cosas sin consulta.** Con los permisos abiertos eso
  incluye instalar dependencias, correr migraciones, commitear y pushear.
  Instalalo en un repo limpio, no en uno con trabajo sin commitear.
- **`max_minutes` es por sesión**, no global. 24h de trabajo real, no 24h de
  proceso colgado.

## Estructura

```
opencode-autonomia.sh    instalador de un solo archivo, autodescomprimible
install.sh               el instalador real, para leerlo y auditarlo
payload/
  opencode.fragment.json  los bloques de config que se mergean
  continuity.json         límites del auto-continue
  continuity.ts           el plugin (motor de auto-continue)
  AGENTS.md               el contrato de no detenerse
```

Para inspeccionar en vez de ejecutar a ciegas:

```bash
curl -fsSL https://raw.githubusercontent.com/extramega1-stack/opencode-autonomy/main/install.sh | less
```

Si modificás `payload/` y regenerás el instalador de un solo archivo:

```bash
tar czf - payload install.sh | base64 -w0
```