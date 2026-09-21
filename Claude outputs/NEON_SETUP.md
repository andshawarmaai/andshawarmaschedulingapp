# Neon CLI Setup Instructions

Your Neon project is already created: **spring-pine-26388976** (production branch)

The schedule-app project now includes a `neon.ts` configuration file ready for Neon CLI integration.

## Setup Steps (run from your machine)

These steps require interactive authentication and must be run from your local machine or a machine with network access to Neon.

### 1. Install Neon CLI and Login

```bash
npm i -g neon@latest
neon login
# This will open a browser for authentication
```

### 2. Set up Neon Skills and MCP

```bash
neon skills -y
neon mcp -y
```

### 3. Link to Your Project

```bash
cd schedule-app
neon link --project-id spring-pine-26388976 --branch production -y
```

This creates `.neon` folder with connection configuration.

### 4. Initialize Neon Config

```bash
neon config init
# This generates additional Neon configuration
```

### 5. Deploy

```bash
neon deploy
```

## What This Does

Once complete, Neon CLI enables:
- Direct Neon database access from the CLI
- Automated backups and branching
- Development branches for testing
- Integration with Neon's serverless features

## Getting the Connection String

After Neon CLI is set up, get your Postgres URL:

```bash
neon connection-string -b production
```

Or through the Neon dashboard:
1. Go to https://console.neon.tech
2. Select your project
3. Click "Connection" in the dashboard
4. Copy the connection string
5. Format: `postgresql://user:password@endpoint.neon.tech/dbname?sslmode=require`

## For Vercel

Once you have the connection string:

1. Push code to GitHub:
   ```bash
   git remote add origin https://github.com/andshawarmaai/scheduling-app.git
   git branch -M main
   git push -u origin main
   ```

2. Deploy to Vercel with the connection string as `POSTGRES_URL` environment variable

## Current Project State

✓ `neon.ts` configuration added to project
✓ Git repository ready to push
✓ Code builds successfully
✓ Ready for Neon CLI linkage

The Neon CLI commands that require authentication couldn't run in the cloud environment but the configuration file is in place and ready for you to complete on your local machine or Waqas's machine.
