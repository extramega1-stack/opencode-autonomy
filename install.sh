#!/usr/bin/env bash
# Instala el modo autonomía en este equipo: el agente trabaja solo hasta que la
# lista de tareas queda vacía, sin preguntar "¿sigo?" entre fases.
#
# Mergea en vez de pisar. Los campos que ya tengas en opencode.json (model,
# provider, mcp, theme...) se conservan; solo se agregan o sobrescriben los
# bloques de autonomía. Todo se backs upea antes de tocar nada.
#
#   ./install.sh              instala / actualiza
#   ./install.sh --dry-run    muestra qué haría, sin escribir
#   ./install.sh --uninstall  saca solo los bloques de autonomía

set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PAYLOAD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/payload"
DRY_RUN=0
UNINSTALL=0
BACKUP_SUFFIX="$(date +%Y%m%d-%H%M%S)"

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)   sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opción desconocida: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n  → %s\n' "$*"; }
ok()   { printf '    ✓ %s\n' "$*"; }
warn() { printf '    ! %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -d "$PAYLOAD_DIR" ] || die "no encuentro el directorio payload al lado del script"

# JSON plano sin dependencias: opencode valida la config al arrancar y aborta si
# algo está mal, así que no podemos dejar un archivo a medio escribir.
have() { command -v "$1" >/dev/null 2>&1; }
if   have python3; then JSON_RUNNER=python3
elif have bun;     then JSON_RUNNER=bun
elif have node;    then JSON_RUNNER=node
elif have jq;      then JSON_RUNNER=jq
else die "necesito python3, bun, node o jq para editar la config"
fi

json_merge() {
  # json_merge <archivo_destino> <fragmento> <modo>
  #   modo=install    agrega/reforza los bloques de autonomía
  #   modo=uninstall  saca solo los bloques de autonomía
  local dest="$1" fragment="$2" mode="${3:-install}"
  if [ "$JSON_RUNNER" = "jq" ]; then
    jq --slurp --arg mode "$mode" '
      def autonomy_keys: ["permission","experimental","agent","compaction"];
      .[0] as $base | .[1] as $frag |
      if $mode == "uninstall" then
        ($base | delpaths([autonomy_keys[] as $k | select(has($k)) | $k])) as $out
        | $out
      else
        (reduce autonomy_keys[] as $k ({}; .[$k] = true)) as $drop
        | ($base | delpaths([$drop[] as $k | select(has($k)) | $k])) as $clean
        | ($clean * $frag)
      end
    ' "$dest" "$fragment"
  else
    "$JSON_RUNNER" - "$dest" "$fragment" "$mode" <<'PY'
import json, sys

dest_path, fragment_path, mode = sys.argv[1], sys.argv[2], sys.argv[3]
with open(dest_path) as f:
    base = json.load(f)
with open(fragment_path) as f:
    frag = json.load(f)

AUTONOMY_KEYS = ("permission", "experimental", "agent", "compaction")

# The permission tools whose value may be either a flat action or a per-pattern
# object. Overwriting a user's object with our flat "allow" is the failure mode
# that matters: `read: {"*.env": "deny"}` becoming `read: "allow"` silently
# un-protects every secret file on the machine.
PATTERN_TOOLS = {"read", "edit", "glob", "grep", "list", "bash", "task", "lsp", "skill"}
FLAT_TOOLS = {"todowrite", "question", "webfetch", "websearch", "doom_loop"}


def merge_permission(existing, incoming):
    out = dict(existing or {})
    for tool, value in incoming.items():
        if tool in FLAT_TOOLS:
            out[tool] = value
            continue
        prior = out.get(tool)
        if isinstance(prior, dict):
            # The user already narrowed this tool with their own patterns. Our
            # intent is "allow everything you didn't explicitly restrict", which
            # is the "*" pattern, not a flat string that would erase their rules.
            if isinstance(value, dict):
                merged = dict(prior)
                for pattern, action in value.items():
                    merged.setdefault(pattern, action)
            elif isinstance(value, str) and prior.get("*") != value:
                merged = {"*": value, **prior}
            else:
                merged = prior
            out[tool] = merged
        else:
            out[tool] = value
    return out


def install():
    for key in AUTONOMY_KEYS:
        if key not in frag:
            continue
        if key == "permission":
            base["permission"] = merge_permission(base.get("permission"), frag[key])
        elif key == "agent":
            # Never drop a user's custom agents; only add/override step counts.
            agents = dict(base.get("agent") or {})
            for name, spec in frag[key].items():
                agents[name] = {**agents.get(name, {}), **spec}
            base["agent"] = agents
        else:
            value = dict(base.get(key) or {})
            value.update(frag[key])
            base[key] = value


def subtract_permission(existing, ours):
    """Remove only the patterns we introduced, and keep whatever the user wrote.

    Subtracting whole tools is wrong: `read` exists both because we added it and
    because the user had `{"*.env": "deny"}` in it. Dropping the key takes their
    rule with it, so we subtract our individual patterns instead.
    """
    frag_perms = ours.get("permission") or {}
    out = {}
    for tool, value in (existing or {}).items():
        if tool not in frag_perms:
            out[tool] = value
            continue
        frag_value = frag_perms[tool]
        if tool in FLAT_TOOLS or not isinstance(value, dict):
            # Ours alone (it did not narrow anything before we got here).
            continue
        frag_patterns = frag_value if isinstance(frag_value, dict) else {"*": frag_value}
        kept = {
            pattern: action for pattern, action in value.items()
            if not (frag_patterns.get(pattern) == action)
        }
        if kept:
            out[tool] = kept
    return out


def uninstall():
    if "permission" in frag:
        remaining = subtract_permission(base.get("permission"), frag)
        if remaining:
            base["permission"] = remaining
        else:
            base.pop("permission", None)
    for key in ("experimental", "compaction"):
        if key not in frag:
            continue
        block = dict(base.get(key) or {})
        for k in frag[key]:
            block.pop(k, None)
        if block:
            base[key] = block
        else:
            base.pop(key, None)
    if "agent" in frag:
        agents = base.get("agent") or {}
        for name, spec in frag["agent"].items():
            if name not in agents:
                continue
            kept = {k: v for k, v in agents[name].items() if k not in spec}
            if kept:
                agents[name] = kept
            else:
                del agents[name]
        if agents:
            base["agent"] = agents
        else:
            base.pop("agent", None)


install() if mode == "install" else uninstall()

bash_rules = (base.get("permission") or {}).get("bash")
if isinstance(bash_rules, dict) and "*" in bash_rules:
    # opencode evaluates the LAST matching rule, so the catch-all has to come
    # first or it would shadow every narrow deny. Only meaningful when the
    # catch-all is actually there: after an uninstall the user may be left with
    # just their own patterns, and inventing a "*" key would resurrect ours.
    order = ["*"] + [k for k in bash_rules if k != "*"]
    base["permission"]["bash"] = {k: bash_rules[k] for k in order}

json.dump(base, open(dest_path, "w"), indent=2, ensure_ascii=False)
open(dest_path, "a").write("\n")
print("ok")
PY
  fi
}

json_validate() {
  if [ "$JSON_RUNNER" = "jq" ]; then
    jq empty "$1"
  else
    "$JSON_RUNNER" -c "import json,sys; json.load(open(sys.argv[1])); print('ok')" "$1" >/dev/null
  fi
}

backup() {
  local f="$1"
  [ -f "$f" ] || return 0
  if [ "$DRY_RUN" = "1" ]; then
    say "    [dry-run] haría backup de $(basename "$f")"
    return 0
  fi
  cp "$f" "$f.bak-$BACKUP_SUFFIX"
  ok "backup: $(basename "$f").bak-$BACKUP_SUFFIX"
}

write_file() {
  local src="$1" dest="$2"
  if [ "$DRY_RUN" = "1" ]; then
    say "    [dry-run] escribiría $(basename "$dest") ($(wc -l <"$src") líneas)"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  ok "$(basename "$dest") instalado"
}

CONFIG_FILE="$CONFIG_DIR/opencode.json"

say ""
say "  Modo autonomía para opencode"
say "  destino: $CONFIG_DIR"

# ---- 0. ¿Existe opencode? -------------------------------------------------
if ! command -v opencode >/dev/null 2>&1; then
  warn "no encontré el binario 'opencode' en el PATH."
  warn "si está en otro lado, instalá la config igual y apuntá OPENCODE_CONFIG_DIR"
fi

# ---- 1. opencode.json ------------------------------------------------------
mkdir -p "$CONFIG_DIR"
if [ "$UNINSTALL" = "1" ]; then
  step "Desinstalando bloques de autonomía de opencode.json"
  [ -f "$CONFIG_FILE" ] || die "no existe $CONFIG_FILE"
  backup "$CONFIG_FILE"
  json_merge "$CONFIG_FILE" "$PAYLOAD_DIR/opencode.fragment.json" uninstall
  ok "bloques de autonomía removidos (model/provider/mcp intactos)"
else
  step "opencode.json"
  if [ ! -f "$CONFIG_FILE" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      say "    [dry-run] crearía opencode.json desde cero"
    else
      printf '%s\n' '{' '  "$schema": "https://opencode.ai/config.json"' \
        '}' > "$CONFIG_FILE"
      ok "opencode.json creado (no existía)"
    fi
  else
    json_validate "$CONFIG_FILE" || die "$CONFIG_FILE no es JSON válido. Corregilo o usá OPENCODE_DISABLE_PROJECT_CONFIG=1 para arrancar y arreglarlo."
    backup "$CONFIG_FILE"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    say "    [dry-run] mergearía: permission, experimental, agent.steps, compaction"
  else
    # Mergea: los patrones que el usuario ya tenía (por ejemplo
    # `read: {"*.env": "deny"}`) se conservan y nuestras reglas se agregan
    # alrededor. Un install repetido tampoco duplica nada.
    json_merge "$CONFIG_FILE" "$PAYLOAD_DIR/opencode.fragment.json" install
    json_validate "$CONFIG_FILE" || die "el merge produjo JSON inválido; el backup está junto al archivo"
    ok "permission / experimental / agent.steps / compaction mergeados"
    if ! grep -q '"\$schema"' "$CONFIG_FILE"; then
      warn "falta \$schema en opencode.json; tu editor no va a validar la config"
    fi
  fi
fi

# ---- 2. continuity.json ---------------------------------------------------
CONT_FILE="$CONFIG_DIR/continuity.json"
step "continuity.json (auto-continue + detección de stagnación)"
if [ "$UNINSTALL" = "1" ]; then
  [ -f "$CONT_FILE" ] && backup "$CONT_FILE"
  rm -f "$CONT_FILE"
  ok "auto-continue apagado (el plugin queda inerte, no hace falta borrarlo)"
else
  if [ -f "$CONT_FILE" ]; then backup "$CONT_FILE"; fi
  write_file "$PAYLOAD_DIR/continuity.json" "$CONT_FILE"
fi

# ---- 3. continuity.ts -----------------------------------------------------
PLUGIN_FILE="$CONFIG_DIR/plugins/continuity.ts"
step "plugins/continuity.ts (el motor de auto-continue)"
if [ "$UNINSTALL" = "1" ]; then
  [ -f "$PLUGIN_FILE" ] && backup "$PLUGIN_FILE"
  rm -f "$PLUGIN_FILE"
  ok "plugin removido"
else
  write_file "$PAYLOAD_DIR/continuity.ts" "$PLUGIN_FILE"
fi

# ---- 4. AGENTS.md ---------------------------------------------------------
AGENTS_FILE="$CONFIG_DIR/AGENTS.md"
step "AGENTS.md (el contrato de no detenerse)"
if [ "$UNINSTALL" = "1" ]; then
  [ -f "$AGENTS_FILE" ] && backup "$AGENTS_FILE"
  rm -f "$AGENTS_FILE"
  ok "AGENTS.md removido"
else
  if [ -f "$AGENTS_FILE" ] && [ "$DRY_RUN" = "0" ] && ! grep -q "Autonomía" "$AGENTS_FILE"; then
    backup "$AGENTS_FILE"
    cat "$AGENTS_FILE" > "$AGENTS_FILE.bak-$BACKUP_SUFFIX"
    say ""
    say "    ! Ya tenías un AGENTS.md propio y no lo sobreescribo."
    say "    ! está en $AGENTS_FILE.bak-$BACKUP_SUFFIX"
    say "    ! mergeá a mano el bloque '## El contrato' si te sirve."
    AGENTS_FILE=""
  fi
  if [ -n "$AGENTS_FILE" ]; then
    if [ -f "$AGENTS_FILE" ]; then backup "$AGENTS_FILE"; fi
    write_file "$PAYLOAD_DIR/AGENTS.md" "$AGENTS_FILE"
  fi
fi

# ---- resumen --------------------------------------------------------------
say ""
if [ "$UNINSTALL" = "1" ]; then
  say "  Listo. Restart opencode para que tome el cambio."
  say "  Los backups están junto a cada archivo, con sufijo .bak-$BACKUP_SUFFIX"
  exit 0
fi

say "  Qué quedó activo"
say "    · permisos en allow: no aparece el diálogo de autorización"
say "    · doom_loop: allow: opencode detecta 3 tool calls idénticas y sigue solo"
say "    · continue_loop_on_deny: un deny no corta el loop"
say "    · steps: 100000: no se frena por límite de iteraciones"
say "    · auto_continue: si se frena con tareas pendientes, se reanuda solo"
say "    · stall detector: 3 intentos sin avance = para y avisa"
say ""
say "  Para revertir todo:  $0 --uninstall"
say ""
say "  ⚠  Reiniciá opencode: la config se carga una vez al arrancar."
say ""
say "  ⚠  Dos cosas que tenés que saber:"
say "    · question: deny  → no te va a preguntar nada, decide él."
say "    · max_minutes 1440 (24h) y max_continues 2000 son las únicas paradas"
say "      automáticas. Subilos en $CONT_FILE si necesitás más."
say ""
if [ "$DRY_RUN" = "1" ]; then
  say "  (dry-run: no se escribió nada)"
fi