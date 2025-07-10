# GrowAGarden Push Notification Server

## 🚀 Heroku Deployment

This server handles push notifications for the GrowAGarden iOS app.

### Required Environment Variables

Set these in your Heroku Config Vars:

```
APNS_KEY_ID=F9J436633X
APNS_TEAM_ID=8U376J9B6U
APNS_BUNDLE_ID=drinpack2.GrowAGarden
APNS_PRODUCTION=false
API_SECRET=growagargen-secret-2025
APNS_KEY_CONTENT=-----BEGIN PRIVATE KEY-----
...your .p8 file content...
-----END PRIVATE KEY-----
```

### API Endpoints

- **GET /** - Health check and status
- **POST /api/register-device** - Register iOS device token
- **POST /api/stock-update** - Update stock and send notifications
- **POST /api/test-notification** - Send test notification
- **GET /api/stats** - Server statistics

### Testing

Visit your deployed URL to see status:
```json
{
  "status": "ok",
  "apns_ready": true,
  "users_count": 0,
  "stock_items": 0
}
```

If `apns_ready: false`, check your APNS_KEY_CONTENT config var.

### Send Test Notification

```bash
curl -X POST https://your-app.herokuapp.com/api/test-notification \
  -H "Content-Type: application/json" \
  -d '{
    "device_token": "your_device_token_here",
    "message": "Test from server!"
  }'
```

### Simulate Stock Update

```bash
curl -X POST https://your-app.herokuapp.com/api/stock-update \
  -H "Content-Type: application/json" \
  -d '{
    "api_secret": "growagargen-secret-2025",
    "items": [
      {"name": "Apple", "quantity": 5},
      {"name": "Tomato", "quantity": 3}
    ]
  }'
``` 