@echo off
echo Stopping gallery-hub demo containers (data preserved on next dev.bat)...
docker stop gh-demo-pg gh-demo-minio gh-demo-imgproxy >nul 2>&1
echo Done. Run dev.bat to start again.
