#!/usr/bin/env node

import { program } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

program
  .name('abacatepay')
  .description('CLI para adicionar servidor MCP do Abacate Pay em IDEs e clients')
  .version('1.0.0');

const mcpCommand = program
  .command('mcp')
  .description('Comandos relacionados ao servidor MCP');

mcpCommand
  .command('init')
  .description('Inicializa o servidor MCP do Abacate Pay no client especificado')
  .requiredOption('--client <client>', 'Client/IDE (cursor, claude)')
  .option('--apiKey <key>', 'API Key do Abacate Pay (opcional, pode ser configurada depois)')
  .action(async (options) => {
    const { client, apiKey } = options;
    
    if (!['cursor', 'claude'].includes(client.toLowerCase())) {
      console.error(`❌ Client "${client}" não é suportado. Use: cursor ou claude`);
      process.exit(1);
    }

    try {
      if (client.toLowerCase() === 'cursor') {
        await configureCursor(apiKey);
      } else if (client.toLowerCase() === 'claude') {
        await configureClaude(apiKey);
      }
    } catch (error) {
      console.error(`❌ Erro ao configurar: ${error.message}`);
      process.exit(1);
    }
  });

async function configureCursor(apiKey) {
  console.log('🔧 Configurando Abacate Pay MCP para Cursor...');
  
  // Verificar primeiro se existe .cursor/mcp.json no projeto atual
  // Se não existir, usar ~/.cursor/mcp.json (configuração global)
  const processCwd = process.cwd();
  const projectConfigPath = join(processCwd, '.cursor', 'mcp.json');
  const globalConfigPath = join(homedir(), '.cursor', 'mcp.json');
  
  let cursorConfigPath;
  let cursorConfigDir;
  
  // Priorizar configuração do projeto se o diretório .cursor existir
  if (existsSync(join(processCwd, '.cursor'))) {
    cursorConfigPath = projectConfigPath;
    cursorConfigDir = join(processCwd, '.cursor');
  } else {
    // Usar configuração global
    cursorConfigPath = globalConfigPath;
    cursorConfigDir = join(homedir(), '.cursor');
  }
  
  // Criar diretório se não existir
  if (!existsSync(cursorConfigDir)) {
    mkdirSync(cursorConfigDir, { recursive: true });
  }

  // Ler configuração existente ou criar nova
  // IMPORTANTE: Preservar TODAS as propriedades do arquivo existente
  let config = {};
  if (existsSync(cursorConfigPath)) {
    try {
      const existingConfig = readFileSync(cursorConfigPath, 'utf-8');
      
      // Verificar se o arquivo está vazio
      if (!existingConfig || existingConfig.trim() === '') {
        config = { mcpServers: {} };
      } else {
        config = JSON.parse(existingConfig);
        // Garantir que mcpServers existe, mas preservar outras propriedades
        if (!config.mcpServers) {
          config.mcpServers = {};
        }
        // Garantir que config é um objeto válido
        if (typeof config !== 'object' || config === null) {
          throw new Error('Configuração inválida');
        }
      }
    } catch (error) {
      console.warn(`⚠️  Erro ao ler arquivo mcp.json: ${error.message}`);
      console.warn('⚠️  Criando novo arquivo...');
      // Tentar fazer backup do arquivo corrompido
      try {
        const backupPath = cursorConfigPath + '.backup.' + Date.now();
        const corruptedContent = readFileSync(cursorConfigPath, 'utf-8');
        writeFileSync(backupPath, corruptedContent, 'utf-8');
        console.warn(`⚠️  Backup do arquivo corrompido salvo em: ${backupPath}`);
      } catch (backupError) {
        // Ignorar erro de backup
      }
      config = { mcpServers: {} };
    }
  } else {
    // Se não existe, criar estrutura básica
    config = { mcpServers: {} };
  }

  // Verificar se já existe configuração do abacatepay
  const isUpdate = config.mcpServers['abacatepay'] !== undefined;
  
  // Preservar configuração existente do abacatepay se houver
  const existingAbacatepayConfig = config.mcpServers['abacatepay'] || {};
  
  // Adicionar ou atualizar APENAS a configuração do Abacate Pay
  // Preservando outras propriedades que possam existir
  config.mcpServers['abacatepay'] = {
    ...existingAbacatepayConfig, // Preservar outras propriedades se existirem
    command: 'npx',
    args: ['-y', 'abacatepay-mcp']
  };

  // Adicionar ou atualizar ABACATE_PAY_API_KEY se fornecida
  if (apiKey) {
    // Preservar outras variáveis de ambiente se existirem
    const existingEnv = existingAbacatepayConfig.env || {};
    config.mcpServers['abacatepay'].env = {
      ...existingEnv,
      ABACATE_PAY_API_KEY: apiKey
    };
  } else if (existingAbacatepayConfig.env) {
    // Se não forneceu API key mas já existe env, preservar
    config.mcpServers['abacatepay'].env = existingAbacatepayConfig.env;
  }

  // Escrever configuração
  writeFileSync(cursorConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  
  console.log('✅ Configuração do Cursor concluída!');
  console.log(`📝 Arquivo ${isUpdate ? 'atualizado' : 'criado'}: ${cursorConfigPath}`);
  
  if (!apiKey) {
    console.log('\n💡 Dica: Você pode adicionar sua API_KEY editando o arquivo mcp.json:');
    console.log('   Adicione "env": { "ABACATE_PAY_API_KEY": "sua-chave-aqui" } na configuração do abacatepay');
  }
}

async function configureClaude(apiKey) {
  console.log('🔧 Configurando Abacate Pay MCP para Claude Code...');
  console.log('⚠️  Claude Code não está disponível no Linux no momento.');
  console.log('📝 Estrutura preparada para implementação futura.');
  
  // TODO: Implementar quando Claude Code estiver disponível no Linux
  // O Claude Code geralmente usa um arquivo de configuração similar
  // Por enquanto, apenas informamos o usuário
}

program.parse();

