# Tao database, bang va du lieu mau cho DCGS.
# Chay:  powershell -ExecutionPolicy Bypass -File setup.ps1
# psql se hoi mat khau cua user postgres.

param(
  [string]$PsqlPath = "C:\Program Files\PostgreSQL\18\bin\psql.exe",
  [string]$DbUser   = "postgres",
  [string]$DbHost   = "127.0.0.1",
  [int]   $DbPort   = 5432
)

if (-not (Test-Path $PsqlPath)) {
  Write-Error "Khong tim thay psql tai $PsqlPath - sua tham so -PsqlPath"
  exit 1
}

$schema = Join-Path $PSScriptRoot "schema.sql"
Write-Host "Dang ap dung $schema vao $DbHost`:$DbPort ..." -ForegroundColor Cyan
& $PsqlPath -U $DbUser -h $DbHost -p $DbPort -v ON_ERROR_STOP=0 -f $schema
if ($LASTEXITCODE -eq 0) {
  Write-Host "Xong. Database 'dcgs' da san sang." -ForegroundColor Green
} else {
  Write-Error "psql tra ve ma loi $LASTEXITCODE"
}
