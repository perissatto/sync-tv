#!/bin/sh
# Mac / Linux / Raspberry Pi
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "Preparando a ponte pela primeira vez..."
  python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt
fi
if [ ! -f config.json ]; then
  printf "Código da sala (aparece no topo do controle no celular): "; read SALA
  exec .venv/bin/python ponte.py --sala "$SALA"
fi
exec .venv/bin/python ponte.py
