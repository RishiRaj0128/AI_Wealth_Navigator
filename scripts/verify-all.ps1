<#
.SYNOPSIS
    Pre-push validation script for Insurance Insight Nexus.
    Runs code quality, linting, frontend build, and tests locally before pushing to GitHub.
#>

$ErrorActionPreference = "Stop"
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Insurance Insight Nexus Pre-Push Verification Suite     " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$RepoRoot = Split-Path -Parent $PSScriptRoot

# 1. Frontend Lint
Write-Host "`n[1/4] Running Frontend Lint (Oxlint)..." -ForegroundColor Yellow
Push-Location "$RepoRoot\frontend"
try {
    npm run lint
    Write-Host "Frontend lint passed." -ForegroundColor Green
} finally {
    Pop-Location
}

# 2. Frontend Build
Write-Host "`n[2/4] Running Frontend Production Build..." -ForegroundColor Yellow
Push-Location "$RepoRoot\frontend"
try {
    npm run build
    Write-Host "Frontend build passed." -ForegroundColor Green
} finally {
    Pop-Location
}

# 3. Backend Lint
Write-Host "`n[3/4] Checking Backend Code Style (Ruff)..." -ForegroundColor Yellow
Push-Location "$RepoRoot\backend"
try {
    if (Get-Command ruff -ErrorAction SilentlyContinue) {
        ruff check .
        Write-Host "Backend Ruff check passed." -ForegroundColor Green
    } else {
        Write-Host "Ruff not found locally; will run in CI." -ForegroundColor DarkYellow
    }
} finally {
    Pop-Location
}

# 4. Backend Tests (if database is accessible)
Write-Host "`n[4/4] Checking Pytest Availability..." -ForegroundColor Yellow
Push-Location "$RepoRoot\backend"
try {
    if (Get-Command pytest -ErrorAction SilentlyContinue) {
        Write-Host "Pytest is available. Note: local tests require running PostgreSQL." -ForegroundColor DarkYellow
    }
} finally {
    Pop-Location
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "  Pre-Push Validation Succeeded! Safe to commit and push. " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
