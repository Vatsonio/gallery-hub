@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM   gallery-hub local dev — full setup in one shot
REM ------------------------------------------------------------
REM   Boots: Postgres 16 + MinIO + applies migrations + seeds
REM          admin + starts Next.js dev server.
REM
REM   Usage:   dev.bat            (start everything)
REM            Ctrl+C             (stop the dev server)
REM            dev-stop.bat       (remove demo containers)
REM            dev-reset.bat      (wipe data + restart fresh)
REM ============================================================

set DB_PORT=5433
set MINIO_PORT=9100
set MINIO_CONSOLE_PORT=9101
set DEV_PORT=3000
set PG_NAME=gh-demo-pg
set MINIO_NAME=gh-demo-minio

echo.
echo === gallery-hub dev bootstrap ===
echo.

REM --- Docker reachable? ---------------------------------------------------
docker info >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker is not running. Start Docker Desktop and re-run dev.bat.
  exit /b 1
)

REM --- Postgres ------------------------------------------------------------
docker ps -a --format "{{.Names}}" | findstr /B /C:"%PG_NAME%" >nul
if errorlevel 1 (
  echo [pg]    starting fresh Postgres on port %DB_PORT% ...
  docker run -d --name %PG_NAME% -p %DB_PORT%:5432 ^
    -e POSTGRES_USER=gallery ^
    -e POSTGRES_PASSWORD=gallery ^
    -e POSTGRES_DB=gallery_hub ^
    postgres:16-alpine >nul
) else (
  echo [pg]    container exists - ensuring it's running ...
  docker start %PG_NAME% >nul 2>&1
)

REM --- MinIO ---------------------------------------------------------------
docker ps -a --format "{{.Names}}" | findstr /B /C:"%MINIO_NAME%" >nul
if errorlevel 1 (
  echo [minio] starting fresh MinIO on port %MINIO_PORT% ^(console %MINIO_CONSOLE_PORT%^) ...
  docker run -d --name %MINIO_NAME% -p %MINIO_PORT%:9000 -p %MINIO_CONSOLE_PORT%:9001 ^
    -e MINIO_ROOT_USER=minio ^
    -e MINIO_ROOT_PASSWORD=minio12345 ^
    -e MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3000 ^
    minio/minio:latest server /data --console-address ":9001" >nul
) else (
  echo [minio] container exists - ensuring it's running ...
  docker start %MINIO_NAME% >nul 2>&1
)

REM --- Wait for both services ----------------------------------------------
echo [wait]  waiting for Postgres + MinIO to be reachable ...
set RETRIES=0
:wait_loop
set /a RETRIES+=1
if %RETRIES% GTR 60 (
  echo [ERROR] services did not become ready in time. Check ^`docker logs %PG_NAME%^` / ^`docker logs %MINIO_NAME%^`.
  exit /b 1
)
docker exec %PG_NAME% pg_isready -U gallery -d gallery_hub >nul 2>&1
if errorlevel 1 ( timeout /t 1 /nobreak >nul & goto wait_loop )
curl -sf -o nul "http://localhost:%MINIO_PORT%/minio/health/ready" >nul 2>&1
if errorlevel 1 ( timeout /t 1 /nobreak >nul & goto wait_loop )

REM --- Bucket --------------------------------------------------------------
echo [minio] ensuring bucket 'gallery' exists ...
docker run --rm --network host -e MC_HOST_gh=http://minio:minio12345@localhost:%MINIO_PORT% ^
  minio/mc mb gh/gallery --ignore-existing >nul 2>&1

REM --- App env -------------------------------------------------------------
set "DATABASE_URL=postgresql://gallery:gallery@localhost:%DB_PORT%/gallery_hub"
set "MINIO_ENDPOINT=http://localhost:%MINIO_PORT%"
set MINIO_ACCESS_KEY=minio
set MINIO_SECRET_KEY=minio12345
set MINIO_BUCKET=gallery
set MINIO_FORCE_PATH_STYLE=true

REM --- SESSION_PASSWORD: rotate per-boot (gitignored cache file) -----------
REM Pentest F1 — the previous hardcoded dev secret was committed to source,
REM so anyone with the repo could forge sessions against any dev instance.
REM We now generate 32 random hex bytes on first boot and cache to
REM .dev-session-password (gitignored). Delete the file to rotate.
set "SESSION_FILE=.dev-session-password"
if not exist "%SESSION_FILE%" (
  for /f "delims=" %%S in ('node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"') do (
    > "%SESSION_FILE%" echo %%S
  )
  echo [auth] generated fresh dev SESSION_PASSWORD ^(%SESSION_FILE%^)
)
set /p SESSION_PASSWORD=<"%SESSION_FILE%"

set "PUBLIC_BASE_URL=http://localhost:%DEV_PORT%"
set ADMIN_EMAIL=admin@divass.space
set ADMIN_PASSWORD=demo1234

REM --- Migrations ----------------------------------------------------------
echo [db]    applying migrations ...
call npm run migrate
if errorlevel 1 (
  echo [ERROR] migrations failed.
  exit /b 1
)

REM --- Seed admin ----------------------------------------------------------
echo [db]    seeding admin user (idempotent) ...
call npm run seed:admin >nul
if errorlevel 1 (
  echo [ERROR] admin seed failed.
  exit /b 1
)

REM --- Worker(s) ----------------------------------------------------------
REM Each worker process owns a pg-boss `boss.work` subscription with its
REM own batchSize concurrency. WORKER_REPLICAS controls how many windows
REM we launch — bumping this is the simplest way to scale derivative
REM throughput on multi-core boxes (each replica adds another N parallel
REM sharp encodes, where N = WORKER_BATCH_SIZE).
REM
REM Defaults: REPLICAS=1, BATCH_SIZE=6 (see workers/index.ts).
if not defined WORKER_REPLICAS set WORKER_REPLICAS=1
if not defined WORKER_BATCH_SIZE set WORKER_BATCH_SIZE=6
echo [worker] launching %WORKER_REPLICAS% derivatives worker process(es), batchSize=%WORKER_BATCH_SIZE% ...
for /L %%R in (1,1,%WORKER_REPLICAS%) do (
  start "gallery-worker-%%R" cmd /k "set DATABASE_URL=%DATABASE_URL%&& set MINIO_ENDPOINT=%MINIO_ENDPOINT%&& set MINIO_ACCESS_KEY=%MINIO_ACCESS_KEY%&& set MINIO_SECRET_KEY=%MINIO_SECRET_KEY%&& set MINIO_BUCKET=%MINIO_BUCKET%&& set MINIO_FORCE_PATH_STYLE=true&& set SESSION_PASSWORD=%SESSION_PASSWORD%&& set WORKER_BATCH_SIZE=%WORKER_BATCH_SIZE%&& set NODE_ENV=development&& npm run worker"
)

echo.
echo ============================================================
echo   READY
echo ============================================================
echo   App           http://localhost:%DEV_PORT%/admin/login
echo   Admin login   admin@divass.space  /  demo1234
echo.
echo   MinIO console http://localhost:%MINIO_CONSOLE_PORT%
echo                 minio / minio12345
echo   Postgres      postgresql://gallery:gallery@localhost:%DB_PORT%/gallery_hub
echo.
echo   Worker        running in a separate cmd window
echo                 (close that window to stop it; Ctrl+C here stops dev only)
echo.
echo   Stop dev:    Ctrl+C
echo   Tear down:   dev-stop.bat   (keeps data)  /  dev-reset.bat (wipes)
echo ============================================================
echo.

call npm run dev

endlocal
