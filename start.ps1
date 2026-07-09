# Metabase AI Assistant - Start Script
Write-Host "Starting Metabase AI Assistant..." -ForegroundColor Cyan

# Start Backend
Write-Host "Starting backend on http://localhost:3001" -ForegroundColor Green
Start-Process powershell -ArgumentList '-NoExit', '-Command', 'cd "backend"; npm run dev' -WorkingDirectory $PSScriptRoot

Start-Sleep -Seconds 2

# Start Frontend
Write-Host "Starting frontend on http://localhost:5173" -ForegroundColor Green
Start-Process powershell -ArgumentList '-NoExit', '-Command', 'cd "frontend"; npm run dev' -WorkingDirectory $PSScriptRoot

Write-Host ""
Write-Host "App will be available at: http://localhost:5173" -ForegroundColor Yellow
Write-Host "Backend API at:           http://localhost:3001" -ForegroundColor Yellow
Write-Host ""
Write-Host "TIP: For the full AI agent, add a FREE Gemini key to backend/.env (GEMINI_API_KEY)." -ForegroundColor Yellow
Write-Host "     Get one at https://aistudio.google.com/apikey  — no billing needed." -ForegroundColor Yellow
