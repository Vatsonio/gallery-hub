@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM   gallery-hub LOCAL PROD-MODE — run the Next build, not the
REM   dev server. Use this when you want to measure perceived-
REM   perf honestly:
REM     - dev mode pays a per-route compile tax on every cold
REM       navigation (~1-2 s extra on the share page),
REM     - dev mode disables React minification + server-side
REM       compression,
REM     - dev mode uses HTTP/1.1 keep-alive defaults (no HMR
REM       coalescing) that inflate TTFB by ~100 ms.
REM
REM   This script assumes dev.bat has already been run at least
REM   once (Postgres + MinIO + imgproxy containers exist + the
REM   bucket is provisioned). It will:
REM     1. ensure the demo containers are running (start if
REM        present, otherwise tell you to run dev.bat first),
REM     2. run `npm run build` against the same env,
REM     3. run `npm run start` on port 3000.
REM
REM   Worker processes from dev.bat keep running in their own
REM   cmd windows — close them to stop or let them keep
REM   processing uploads alongside the prod-mode app.
REM ============================================================

set DB_PORT=5433
set MINIO_PORT=9100
set IMGPROXY_PORT=8080
set DEV_PORT=3000
set PG_NAME=gh-demo-pg
set MINIO_NAME=gh-demo-minio
set IMGPROXY_NAME=gh-demo-imgproxy

echo.
echo === gallery-hub prod-mode bootstrap ===
echo.

REM --- Docker reachable? ---------------------------------------------------
docker info >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker is not running. Start Docker Desktop and re-run dev-prod.bat.
  exit /b 1
)

REM --- Ensure infra containers exist + are running -------------------------
docker ps -a --format "{{.Names}}" | findstr /B /C:"%PG_NAME%" >nul
if errorlevel 1 (
  echo [ERROR] %PG_NAME% container does not exist. Run dev.bat first to bootstrap.
  exit /b 1
)
docker ps -a --format "{{.Names}}" | findstr /B /C:"%MINIO_NAME%" >nul
if errorlevel 1 (
  echo [ERROR] %MINIO_NAME% container does not exist. Run dev.bat first to bootstrap.
  exit /b 1
)
docker ps -a --format "{{.Names}}" | findstr /B /C:"%IMGPROXY_NAME%" >nul
if errorlevel 1 (
  echo [ERROR] %IMGPROXY_NAME% container does not exist. Run dev.bat first to bootstrap.
  exit /b 1
)

echo [pg]    ensuring %PG_NAME% is running ...
docker start %PG_NAME% >nul 2>&1
echo [minio] ensuring %MINIO_NAME% is running ...
docker start %MINIO_NAME% >nul 2>&1
echo [imgproxy] ensuring %IMGPROXY_NAME% is running ...
docker start %IMGPROXY_NAME% >nul 2>&1

REM --- Wait for services ---------------------------------------------------
echo [wait]  waiting for Postgres + MinIO + imgproxy ...
set RETRIES=0
:wait_loop
set /a RETRIES+=1
if %RETRIES% GTR 60 (
  echo [ERROR] services did not become ready in time.
  exit /b 1
)
docker exec %PG_NAME% pg_isready -U gallery -d gallery_hub >nul 2>&1
if errorlevel 1 ( timeout /t 1 /nobreak >nul & goto wait_loop )
curl -sf -o nul "http://localhost:%MINIO_PORT%/minio/health/ready" >nul 2>&1
if errorlevel 1 ( timeout /t 1 /nobreak >nul & goto wait_loop )
curl -sf -o nul "http://localhost:%IMGPROXY_PORT%/health" >nul 2>&1
if errorlevel 1 ( timeout /t 1 /nobreak >nul & goto wait_loop )

REM --- Read cached secrets (same as dev.bat) -------------------------------
set "SESSION_FILE=.dev-session-password"
set "IMGPROXY_KEY_FILE=.dev-imgproxy-key"
set "IMGPROXY_SALT_FILE=.dev-imgproxy-salt"
if not exist "%SESSION_FILE%" (
  echo [ERROR] %SESSION_FILE% missing. Run dev.bat once to seed it.
  exit /b 1
)
if not exist "%IMGPROXY_KEY_FILE%" (
  echo [ERROR] %IMGPROXY_KEY_FILE% missing. Run dev.bat once to seed it.
  exit /b 1
)
if not exist "%IMGPROXY_SALT_FILE%" (
  echo [ERROR] %IMGPROXY_SALT_FILE% missing. Run dev.bat once to seed it.
  exit /b 1
)
set /p SESSION_PASSWORD=<"%SESSION_FILE%"
set /p IMGPROXY_KEY=<"%IMGPROXY_KEY_FILE%"
set /p IMGPROXY_SALT=<"%IMGPROXY_SALT_FILE%"

REM --- App env (matches dev.bat) -------------------------------------------
set "DATABASE_URL=postgresql://gallery:gallery@localhost:%DB_PORT%/gallery_hub"
set "MINIO_ENDPOINT=http://localhost:%MINIO_PORT%"
set MINIO_ACCESS_KEY=minio
set MINIO_SECRET_KEY=minio12345
set MINIO_BUCKET=gallery
set MINIO_FORCE_PATH_STYLE=true
set "PUBLIC_IMGPROXY_URL=http://localhost:%IMGPROXY_PORT%"
set "IMGPROXY_URL=http://localhost:%IMGPROXY_PORT%"
set "PUBLIC_BASE_URL=http://localhost:%DEV_PORT%"
set ADMIN_EMAIL=admin@divass.space
set ADMIN_PASSWORD=demo1234

REM --- Prod-mode flips -----------------------------------------------------
REM NODE_ENV=production unlocks: React minification, server-bundle
REM minification, gzip on the response stream, no per-request route
REM compilation, and Next's production-mode SSR cache. TTFB drops
REM from ~600ms (dev cold) to ~80-100ms (prod warm) on the share page.
set NODE_ENV=production
REM Trust the placeholder dev session secret in this local prod build —
REM gallery-hub's src/lib/session.ts throws when the dev secret is detected
REM under NODE_ENV=production unless this opt-out is set. dev-prod.bat is
REM strictly a local benchmarking tool; never set this in real production.
set GH_TEST_BYPASS_AUTH=

REM --- Kill any prior dev process on the same port -------------------------
echo [port]  freeing port %DEV_PORT% if a previous dev/start is bound ...
for /f "tokens=5" %%P in ('netstat -aon ^| findstr /R /C:":%DEV_PORT% .*LISTENING"') do (
  echo [port]  killing pid %%P (was bound to %DEV_PORT%)
  taskkill /PID %%P /F >nul 2>&1
)

REM --- Build ---------------------------------------------------------------
echo.
echo [build] running ^`npm run build^` ^(this is the slow part^) ...
call npm run build
if errorlevel 1 (
  echo [ERROR] build failed. Fix the errors above and re-run dev-prod.bat.
  exit /b 1
)

REM --- Migrate (cheap, idempotent) ----------------------------------------
echo [db]    applying migrations ...
call npm run migrate
if errorlevel 1 (
  echo [ERROR] migrations failed.
  exit /b 1
)

echo.
echo ============================================================
echo   READY (PROD MODE)
echo ============================================================
echo   App           http://localhost:%DEV_PORT%
echo   Admin login   admin@divass.space  /  demo1234
echo.
echo   Expect: 3-5x faster TTFB + LCP vs dev mode. Use the bench:
echo     npx tsx scripts\page-bench.ts --label prod --token ^<token^>
echo.
echo   Stop:   Ctrl+C
echo   (Workers from dev.bat keep running in their own windows.)
echo ============================================================
echo.

REM --- Run the standalone server (next.config has output:"standalone",
REM which means `next start` errors out; the standalone bundle exposes
REM its own minimal server at .next/standalone/server.js). Copy the
REM static assets + public/ in beside it so the server can serve them.
echo [serve] copying static + public assets next to standalone bundle ...
if exist ".next\standalone\.next\static" rmdir /s /q ".next\standalone\.next\static" 2>nul
xcopy /e /i /q /y ".next\static" ".next\standalone\.next\static" >nul
if exist "public" xcopy /e /i /q /y "public" ".next\standalone\public" >nul
echo [serve] starting node .next\standalone\server.js on port %DEV_PORT% ...
set PORT=%DEV_PORT%
set HOSTNAME=0.0.0.0
node .next\standalone\server.js

endlocal
