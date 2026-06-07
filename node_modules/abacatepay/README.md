# Abacate Pay CLI

CLI para adicionar o servidor MCP do Abacate Pay em IDEs e clients.

## Instalação e Uso

```bash
# Com Bun
bunx abacatepay mcp init --client cursor

# Com npm
npx abacatepay mcp init --client cursor

# Com pnpm
pnpm dlx abacatepay mcp init --client cursor

# Com yarn
yarn dlx abacatepay mcp init --client cursor
```

### Com API Key

```bash
bunx abacatepay mcp init --client cursor --apiKey sua-chave-aqui
```

## O que faz?

- Cria ou atualiza o arquivo `mcp.json` do Cursor
- **Preserva** todos os outros servidores MCP já configurados
- Configura o servidor `abacatepay-mcp` automaticamente

## Requisitos

- Node.js >= 18.0.0
