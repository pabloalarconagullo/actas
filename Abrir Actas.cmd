@echo off
rem Arranca Actas en este ordenador y la abre en el navegador.
cd /d "%~dp0"
start "" http://localhost:4410
node serve.mjs
