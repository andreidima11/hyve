# Integration Template - Entity Framework

This document describes the standard structure for Memini integrations with entity management.

## Integration Manifest Schema

```json
{
  "slug": "my_integration",
  "name": "My Integration Name",
  "description": "...",
  "version": "1.0.0",
  "category": "service",
  
  "config_schema": [
    // Configuration fields
  ],
  
  // NEW: Entity exposure configuration
  "entities_schema": {
    "enabled": true,
    "fetch_interval_seconds": 300,  // Update interval (5 min default)
    "endpoint": "/api/my_integration/entities",  // API path to fetch entities
    "entities": [
      {
        "id": "account_balance",
        "name": "Account Balance",
        "type": "number",  // number, string, boolean, object
        "unit": "USD",
        "description": "Current account balance"
      },
      {
        "id": "last_transaction",
        "name": "Last Transaction",
        "type": "object",
        "description": "Details of the last transaction"
      }
    ]
  },
  
  "install": {
    "method": "pip",
    "packages": ["package-name"],
    "post_install_patches": []
  }
}
```

## Entity Types

- **number**: Numeric value (float, int) — can have units
- **string**: Text value
- **boolean**: True/false state
- **object**: Complex JSON object (stored as-is)
- **array**: Array of items

## Implementing Entity Fetching

### 1. Add to your integration router

```python
@router.get("/entities")
async def get_entities(user=Depends(get_current_user)):
    """Return all entity values for this integration."""
    try:
        entities = {
            "account_balance": 1234.56,
            "last_transaction": {
                "date": "2026-03-31",
                "amount": 500,
                "merchant": "Store Name"
            }
        }
        return {"entities": entities, "timestamp": datetime.now().isoformat()}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
```

### 2. Entity Sync (automatic, handled by core)

The sync service will:
- Periodically call your `/api/{slug}/entities` endpoint
- Store results in the `integration_entities` table
- Handle errors gracefully (retry on failure)
- Expose entities via `/api/integrations/{slug}/entities` endpoint

### 3. Make entities available to AI

Entities are automatically injected into LLM context:
- Available in prompt context window
- Can be referenced by tools
- Formatted as structured data

## Example: Pago Integration

```json
{
  "slug": "pago",
  "name": "Pago",
  "entities_schema": {
    "enabled": true,
    "fetch_interval_seconds": 600,
    "endpoint": "/api/pago/entities",
    "entities": [
      {
        "id": "account_balance",
        "name": "Account Balance",
        "type": "number",
        "unit": "RON",
        "description": "Current account balance"
      },
      {
        "id": "account_holder",
        "name": "Account Holder",
        "type": "string",
        "description": "Name on the account"
      },
      {
        "id": "recent_transactions",
        "name": "Recent Transactions",
        "type": "array",
        "description": "Last 10 transactions"
      }
    ]
  }
}
```

## Future Integrations

Examples of what can be exposed:

- **Zigbee2MQTT**: Device states, battery levels, signal strength
- **Home Assistant**: Light states, temperature sensors, switches
- **Spotify**: Current playing track, playlists, user profile
- **Weather API**: Current conditions, forecast data
- **Calendar**: Upcoming events, meeting details
- **Banking**: Account balance, recent transactions
- **Task Manager**: Open tasks, due dates, priorities

Each gains automatic:
- Local storage of data
- Configurable update intervals
- AI context injection
- Admin UI display
