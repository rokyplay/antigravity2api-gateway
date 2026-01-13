# Antigravity2API Gateway

An enhanced Google Antigravity to OpenAI-compatible API gateway with Claude Code support, WebSearch, extended thinking, and robust tool calling.

**Deploy once, code anywhere** - Perfect for cloud-based development environments.

## Features

### Core Features (from original project)
- OpenAI API compatible format
- Streaming and non-streaming responses
- Multi-account automatic rotation
- Token auto-refresh
- API Key authentication
- Thinking/Reasoning output (DeepSeek reasoning_content format)
- Image input/output support
- Web management interface

### Enhanced Features (Gateway Edition)
- **Claude Code / Claude Code Router support** - Full compatibility with Claude Code CLI and routing solutions
- **WebSearch via Gemini grounding** - Automatic web search using gemini-2.5-flash as search engine
- **Extended thinking models** - Support for thinking models with proper signature handling
- **Empty response auto-retry** - Automatically retry when upstream returns empty response
- **429/503 intelligent retry** - Smart retry with exponential backoff and token rotation
- **Cache control cleaning** - Proper handling of Claude's cache_control fields
- **Parameter remapping** - Automatic tool parameter name correction

## Quick Start

### Docker Deployment (Recommended)

```bash
# Clone the repository
git clone https://github.com/rokyplay/antigravity2api-gateway.git
cd antigravity2api-gateway

# Copy config files
cp .env.example .env
cp config.json.example config.json

# Edit .env with your settings
nano .env

# Start with Docker Compose
docker compose up -d
```

### Manual Installation

```bash
# Install dependencies
npm install

# Login to get tokens
npm run login

# Start server
npm start
```

Service will be available at `http://localhost:8045`

## Configuration

### Environment Variables (.env)

```env
# Required
API_KEY=sk-your-api-key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password
JWT_SECRET=your-jwt-secret

# Optional
# PROXY=http://127.0.0.1:7890
# SYSTEM_INSTRUCTION=You are a helpful assistant
```

### Server Config (config.json)

```json
{
  "server": {
    "port": 8045,
    "host": "0.0.0.0",
    "heartbeatInterval": 15000,
    "memoryThreshold": 100
  },
  "rotation": {
    "strategy": "request_count",
    "requestCount": 50
  },
  "other": {
    "retryTimes": 3
  }
}
```

## API Endpoints

| Endpoint | Format | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | OpenAI | Chat completions API |
| `/v1/messages` | Claude | Claude messages API |
| `/v1/models` | OpenAI | List available models |

## Use Cases

### Cloud Development
Deploy on a cloud server, access from anywhere. Works great with:
- Claude Code CLI
- Claude Code Router
- Low-spec cloud instances for remote development

### Multi-Account Load Balancing
- Automatic token rotation
- Quota-based switching
- 429 error handling with retry

## Credits & Acknowledgments

This project is a fork of [antigravity2api-nodejs](https://github.com/liuw1535/antigravity2api-nodejs) by liuw1535.

Additional inspiration and code patterns from:
- [Antigravity-Manager](https://github.com/) - Format conversion patterns
- [claude-code-router](https://github.com/) - Schema cleaning and web search formatting

## License

CC BY-NC-SA 4.0 - Same as the original project.

This means:
- **Attribution** - You must give appropriate credit
- **NonCommercial** - You may not use this for commercial purposes
- **ShareAlike** - Derivatives must use the same license
