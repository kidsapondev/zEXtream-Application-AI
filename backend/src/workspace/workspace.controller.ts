import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { WorkspaceBridgeClient } from '../ai/tools/workspace-bridge.client';
import { WorkspaceToolsService } from '../ai/tools/workspace-tools.service';
import { ExecDto } from './dto/exec.dto';
import { ReadFileQueryDto } from './dto/read-file-query.dto';
import { SearchQueryDto } from './dto/search-query.dto';
import { WriteFileDto } from './dto/write-file.dto';

/**
 * The host workspace, exposed to the browser.
 *
 * Everything here already existed for the Ollama provider's tool loop — the model could read
 * and write the host's files, and the web UI could not. That asymmetry is what kept the
 * browser limited to a chat transcript while the terminal app got a real editor.
 *
 * ## Why this is not a general file API
 *
 * Every route delegates to `WorkspaceBridgeClient`, which reaches the host-bridge, which
 * resolves each path inside `BRIDGE_WORKSPACE_ROOT` and refuses anything outside it. This
 * controller deliberately performs no path handling of its own: a second implementation of
 * containment is a second place to get it wrong, and the one on the host is the one that has
 * the real filesystem to check against (symlinks included).
 *
 * ## Why it is admin-shaped rather than per-user
 *
 * There is exactly one workspace and it belongs to the machine, not to an account. Two users
 * editing it are editing the same files. That is acceptable for the single-operator
 * deployment this is built for — the same assumption `docs/deployment.md` already documents
 * for the claude/codex bridge — but it means the feature must be **off** unless the operator
 * turned it on, which is what the `isEnabled()` check on every route enforces.
 */
@Controller('workspace')
export class WorkspaceController {
  constructor(
    private readonly bridge: WorkspaceBridgeClient,
    private readonly tools: WorkspaceToolsService,
  ) {}

  /** Refuses every route when the operator never configured a workspace. */
  private assertEnabled(): void {
    if (!this.tools.isEnabled()) {
      throw new ServiceUnavailableException(
        'The host workspace is not configured. Set WORKSPACE_BRIDGE_URL in the backend ' +
          'environment and BRIDGE_WORKSPACE_ROOT in host-bridge/.env.',
      );
    }
  }

  @Get('status')
  async status() {
    // Deliberately answers even when unconfigured: this is the endpoint the UI calls to find
    // out *why* nothing else works, so failing it would hide the explanation.
    return this.bridge.status();
  }

  @Get('files')
  async list(@Query('path') path?: string) {
    this.assertEnabled();
    return this.bridge.list({ path: path ?? '' });
  }

  @Get('file')
  async read(@Query() query: ReadFileQueryDto) {
    this.assertEnabled();
    return this.bridge.read({ path: query.path });
  }

  @Post('file')
  @HttpCode(200)
  async write(@Body() body: WriteFileDto) {
    this.assertEnabled();
    return this.bridge.write({ path: body.path, content: body.content });
  }

  @Get('search')
  async search(@Query() query: SearchQueryDto) {
    this.assertEnabled();
    return this.bridge.search({
      query: query.query,
      path: query.path ?? '',
      maxResults: query.maxResults,
    });
  }

  @Post('exec')
  @HttpCode(200)
  async exec(@Body() body: ExecDto) {
    this.assertEnabled();
    const status = await this.bridge.status();
    if (!status.execEnabled) {
      // A distinct error from "not allowlisted": the operator has to change a different
      // setting, and a user told the wrong one will simply try a different command.
      throw new ForbiddenException(
        'Command execution is disabled. Set BRIDGE_EXEC_ALLOWLIST in host-bridge/.env.',
      );
    }
    return this.bridge.exec({
      command: body.command,
      args: body.args ?? [],
      cwd: body.cwd ?? '',
    });
  }

  // No route here runs the model. That is deliberate: the chat WebSocket already drives the
  // full model -> tool -> model loop against this same workspace, streams each tool call as
  // it happens, and stops on request. A second, non-streaming agent endpoint would be a
  // second loop to keep in step with the first — the exact duplication the host-bridge and
  // backend loops already cost once. The browser asks for agent work over the socket it
  // already has open.
}
