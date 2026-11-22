@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist .venv goto pronto
echo Preparando a ponte pela primeira vez...
py -3 -m venv .venv 2>nul || python -m venv .venv
.venv\Scripts\python -m pip install -q -r requirements.txt
:pronto
if exist config.json goto rodar
set /p SALA="Codigo da sala (aparece no topo do controle no celular): "
.venv\Scripts\python ponte.py --sala %SALA%
goto fim
:rodar
.venv\Scripts\python ponte.py
:fim
pause
