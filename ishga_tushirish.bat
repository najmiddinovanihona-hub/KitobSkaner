@echo off
cd /d "%~dp0"
python -c "import cv2, numpy, PIL" 2>nul || python -m pip install -r requirements.txt
start "" pythonw kitob_skaner.py
