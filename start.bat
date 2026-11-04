@echo off
chcp 65001 >nul
title Лира — голосовой помощник
cd /d "%~dp0"
where python >nul 2>nul && (python server.py & goto :eof)
where py >nul 2>nul && (py server.py & goto :eof)
echo Python не найден. Установите Python 3 с python.org (отметьте "Add Python to PATH").
pause
