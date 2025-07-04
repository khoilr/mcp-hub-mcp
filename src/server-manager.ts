import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ConnectMcpParams,
  McpConfig,
  McpServerConfig,
} from "./types.js";
import fs from "fs";
import path from "path";

/**
 * Find configuration file path
 * Check in order: environment variable > command line argument > default path
 */
function findConfigPath(): string | undefined {
  // Check environment variable
  if (process.env.MCP_CONFIG_PATH) {
    return process.env.MCP_CONFIG_PATH;
  }

  // Check command line arguments
  const configArgIndex = process.argv.findIndex(
    (arg) => arg === "--config-path"
  );
  if (
    configArgIndex !== -1 &&
    configArgIndex < process.argv.length - 1
  ) {
    return process.argv[configArgIndex + 1];
  }

  // Check default paths
  const defaultPaths = [
    "./mcp-config.json",
    path.join(process.cwd(), "mcp-config.json"),
  ];

  for (const defaultPath of defaultPaths) {
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }
  }

  return undefined;
}

/**
 * Load configuration file
 */
function loadConfigFile(configPath: string): McpConfig {
  try {
    const configContent = fs.readFileSync(
      configPath,
      "utf-8"
    );
    return JSON.parse(configContent) as McpConfig;
  } catch (error) {
    console.error(
      `Failed to load configuration file: ${
        (error as Error).message
      }`
    );
    throw new Error(
      `Failed to load configuration file '${configPath}': ${
        (error as Error).message
      }`
    );
  }
}

export class McpServerManager {
  private clients: Map<string, Client> = new Map();
  private configPath?: string;

  /**
   * MCP Server Manager constructor
   */
  constructor(options?: {
    configPath?: string;
    autoLoad?: boolean;
  }) {
    this.configPath =
      options?.configPath || findConfigPath();

    if (options?.autoLoad && this.configPath) {
      try {
        this.loadFromConfig(this.configPath);
      } catch (error) {
        console.error(
          `Failed to load servers from configuration file: ${
            (error as Error).message
          }`
        );
      }
    }
  }

  /**
   * Load server configuration from configuration file
   */
  async loadFromConfig(configPath?: string): Promise<void> {
    const path = configPath || this.configPath;
    if (!path) {
      throw new Error(
        "Configuration file path not specified."
      );
    }

    const config = loadConfigFile(path);

    if (
      !config.mcpServers ||
      Object.keys(config.mcpServers).length === 0
    ) {
      console.warn(
        "No server information in configuration file."
      );
      return;
    }

    // Connect to all servers
    const serverEntries = Object.entries(config.mcpServers);
    for (const [
      serverName,
      serverConfig,
    ] of serverEntries) {
      if (this.clients.has(serverName)) {
        continue;
      }

      try {
        await this.connectToServer(
          serverName,
          serverConfig
        );
      } catch (error) {
        console.error(
          `Failed to connect to server '${serverName}' from configuration file: ${
            (error as Error).message
          }`
        );
      }
    }
  }

  /**
   * Connect to MCP server.
   */
  async connectToServer(
    serverName: string,
    params: ConnectMcpParams | McpServerConfig
  ): Promise<void> {
    if (this.clients.has(serverName)) {
      throw new Error(
        `Already connected to server '${serverName}'.`
      );
    }

    // Determine transport type
    const transportType = params.type || (params.command ? "stdio" : "http");
    
    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    if (transportType === "http") {
      // HTTP transport
      if (!params.url) {
        throw new Error(
          `HTTP server '${serverName}' requires a URL.`
        );
      }
      
      const url = new URL(params.url);
      
      // Create transport with headers in requestInit
      const transportOptions: any = {};
      if (params.headers) {
        transportOptions.requestInit = {
          headers: params.headers
        };
      }
      
      transport = new StreamableHTTPClientTransport(url, transportOptions);
    } else {
      // Stdio transport
      if (!params.command) {
        throw new Error(
          `Stdio server '${serverName}' requires a command.`
        );
      }

      // Set environment variables
      const env: Record<string, string | undefined> = {
        ...process.env,
      };
      if ("env" in params && params.env) {
        Object.assign(env, params.env);
      }

      transport = new StdioClientTransport({
        command: params.command,
        args: params.args || [],
        env: env as Record<string, string>,
      });
    }

    const client = new Client({
      name: `mcp-client-${serverName}`,
      version: "1.0.0",
    });

    try {
      await client.connect(transport);
      this.clients.set(serverName, client);
    } catch (error) {
      console.error(
        `Failed to connect to server '${serverName}':`,
        error
      );
      throw new Error(
        `Failed to connect to server '${serverName}': ${
          (error as Error).message
        }`
      );
    }
  }

  /**
   * Return the list of tools from connected server.
   */
  async listTools(serverName: string): Promise<any> {
    const client = this.getClient(serverName);
    return await client.listTools();
  }

  /**
   * Get a specific tool with complete schema from a connected server.
   */
  async getTool(serverName: string, toolName: string): Promise<any> {
    const client = this.getClient(serverName);
    const toolsResponse = await client.listTools();
    
    if (!toolsResponse.tools || !Array.isArray(toolsResponse.tools)) {
      throw new Error(`No tools found on server '${serverName}'`);
    }

    const tool = toolsResponse.tools.find((t: any) => t.name === toolName);
    
    if (!tool) {
      throw new Error(`Tool '${toolName}' not found on server '${serverName}'`);
    }

    return tool;
  }

  /**
   * List tools from a specific server (name and description only).
   */
  async listToolsInServer(serverName: string): Promise<any> {
    const client = this.getClient(serverName);
    const toolsResponse = await client.listTools();
    
    if (!toolsResponse.tools || !Array.isArray(toolsResponse.tools)) {
      return { tools: [] };
    }

    // Filter to only include name and description
    return {
      tools: toolsResponse.tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description,
      }))
    };
  }

  /**
   * Find tools matching a pattern in a specific server (name and description only).
   */
  async findToolsInServer(
    serverName: string,
    pattern: string,
    searchIn: "name" | "description" | "both" = "both",
    caseSensitive: boolean = false
  ): Promise<any[]> {
    const client = this.getClient(serverName);
    const toolsResponse = await client.listTools();

    if (!toolsResponse.tools || !Array.isArray(toolsResponse.tools)) {
      return [];
    }

    const flags = caseSensitive ? "g" : "gi";
    const regex = new RegExp(pattern, flags);

    const matchedTools = toolsResponse.tools.filter((tool: any) => {
      const nameMatch = searchIn !== "description" && tool.name && regex.test(tool.name);
      const descriptionMatch = searchIn !== "name" && tool.description && regex.test(tool.description);
      return nameMatch || descriptionMatch;
    });

    // Filter to only include name and description
    return matchedTools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
    }));
  }

  /**
   * List all connected server names.
   */
  listServers(): string[] {
    return this.getConnectedServers();
  }

  /**
   * Call a tool on server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<any> {
    const client = this.getClient(serverName);
    return await client.callTool({
      name: toolName,
      arguments: args,
    });
  }

  /**
   * Return all connected server names.
   */
  getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Find tools matching a pattern across all connected servers.
   */
  async findTools(
    pattern: string,
    options: {
      searchIn?: "name" | "description" | "both";
      caseSensitive?: boolean;
    } = {}
  ): Promise<Record<string, any[]>> {
    const { searchIn = "both", caseSensitive = false } = options;
    const servers = this.getConnectedServers();
    
    if (servers.length === 0) {
      return {};
    }

    // Create regex pattern
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseSensitive ? "" : "i");
    } catch (error) {
      throw new Error(`Invalid regex pattern: ${(error as Error).message}`);
    }

    const results: Record<string, any[]> = {};

    // Search tools in each server
    for (const serverName of servers) {
      try {
        const toolsResponse = await this.listTools(serverName);
        
        if (toolsResponse.tools && Array.isArray(toolsResponse.tools)) {
          const matchedTools = toolsResponse.tools.filter((tool: any) => {
            const nameMatch = searchIn !== "description" && tool.name && regex.test(tool.name);
            const descriptionMatch = searchIn !== "name" && tool.description && regex.test(tool.description);
            return nameMatch || descriptionMatch;
          }).map((tool: any) => ({
            name: tool.name,
            description: tool.description,
          }));

          if (matchedTools.length > 0) {
            results[serverName] = matchedTools;
          }
        }
      } catch (error) {
        // Include error information in results
        results[serverName] = [{
          error: `Failed to search tools: ${(error as Error).message}`
        }];
      }
    }

    return results;
  }

  /**
   * Disconnect from server.
   */
  async disconnectServer(
    serverName: string
  ): Promise<void> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(
        `Not connected to server '${serverName}'.`
      );
    }
    try {
      await client.close();
      this.clients.delete(serverName);
    } catch (error) {
      console.error(
        `Failed to disconnect from server '${serverName}':`,
        error
      );
      throw new Error(
        `Failed to disconnect from server '${serverName}': ${
          (error as Error).message
        }`
      );
    }
  }

  /**
   * Disconnect from all servers.
   */
  async disconnectAll(): Promise<void> {
    const serverNames = this.getConnectedServers();
    for (const serverName of serverNames) {
      await this.disconnectServer(serverName);
    }
  }

  private getClient(serverName: string): Client {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(
        `Not connected to server '${serverName}'.`
      );
    }
    return client;
  }
}
