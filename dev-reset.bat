@echo off
echo Wiping gallery-hub demo containers AND their data...
docker rm -f gh-demo-pg gh-demo-minio >nul 2>&1
echo Done. Run dev.bat for a clean rebuild.
