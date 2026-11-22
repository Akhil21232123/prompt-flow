#!/usr/bin/env bash
# Deploys the PromptFlow backend to Supabase from your Mac.
# Keys are typed here (hidden) and stored as Supabase secrets; they are
# never written to disk or committed.
set -euo pipefail
cd "$(dirname "$0")/../backend"

say() { printf "\n\033[1;35m▸ %s\033[0m\n" "$*"; }

if ! command -v supabase >/dev/null; then
  say "Installing the Supabase CLI"
  brew install supabase/tap/supabase
fi

say "Signing in to Supabase (a browser tab opens)"
supabase login

say "Pick your project (create one at supabase.com/dashboard first if needed)"
supabase projects list
read -rp "Project ref (the 20-letter id): " REF
supabase link --project-ref "$REF"

say "Paste your keys (input is hidden)"
read -rsp "Anthropic API key (sk-ant-…): " ANTHROPIC; echo
read -rsp "Groq API key (gsk_…), for speech-to-text: " GROQ; echo
read -rsp "OpenAI API key (optional backup STT, Enter to skip): " OPENAI; echo
SECRETS=("ANTHROPIC_API_KEY=$ANTHROPIC" "GROQ_API_KEY=$GROQ")
[ -n "$OPENAI" ] && SECRETS+=("OPENAI_API_KEY=$OPENAI")
supabase secrets set "${SECRETS[@]}"
unset ANTHROPIC GROQ OPENAI SECRETS

say "Creating tables"
supabase db push

say "Deploying functions"
supabase functions deploy health --no-verify-jwt
supabase functions deploy dictate rewrite learn

URL="https://$REF.supabase.co"
say "Checking it's live"
curl -fsS "$URL/functions/v1/health" && echo

ANON=$(supabase projects api-keys --project-ref "$REF" -o json 2>/dev/null \
  | python3 -c "import json,sys; print(next(k['api_key'] for k in json.load(sys.stdin) if k['name']=='anon'))" 2>/dev/null || true)

say "Done. Put these in the apps (both are public, safe to share):"
echo "  Server URL: $URL"
echo "  Anon key:   ${ANON:-<Supabase dashboard → Project Settings → API → anon public>}"
