#!/bin/bash

# GrowAGarden Server Deployment Script
echo "🚀 Deploying GrowAGarden Push Notification Server..."

# Check if we're in a git repository
if [ ! -d ".git" ]; then
    echo "📂 Initializing git repository..."
    git init
fi

# Add all files
echo "📁 Adding files to git..."
git add .

# Commit changes
echo "💾 Committing changes..."
git commit -m "Update server configuration for APNs push notifications

- Updated bundle ID to drinpack2.GrowAGarden
- Updated API secret to growagargen-secret-2025
- Added README with deployment instructions
- Added .gitignore for security
- Ready for Heroku deployment"

# Push to GitHub (if remote exists)
if git remote get-url origin > /dev/null 2>&1; then
    echo "📤 Pushing to GitHub..."
    git push origin main
    echo "✅ Deployment complete! Check your Heroku dashboard for auto-deployment."
else
    echo "⚠️  No GitHub remote configured. Please:"
    echo "   1. Create GitHub repository"
    echo "   2. git remote add origin https://github.com/drinpack2/growagargen-server.git"
    echo "   3. git push -u origin main"
fi

echo ""
echo "🔧 Don't forget to set these Heroku Config Vars:"
echo "   APNS_KEY_ID=F9J436633X"
echo "   APNS_TEAM_ID=8U376J9B6U"
echo "   APNS_BUNDLE_ID=drinpack2.GrowAGarden"
echo "   APNS_PRODUCTION=false"
echo "   API_SECRET=growagargen-secret-2025"
echo "   APNS_KEY_CONTENT=<your .p8 file content>"
echo ""
echo "🌐 Test your deployment at:"
echo "   https://growagargen-server-0ee459fc1157a.herokuapp.com/" 