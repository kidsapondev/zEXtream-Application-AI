import { Injectable } from '@nestjs/common';

@Injectable()
export class ActiveStreamRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(messageId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(messageId, controller);
    return controller;
  }

  stop(messageId: string): boolean {
    const controller = this.controllers.get(messageId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  release(messageId: string) {
    this.controllers.delete(messageId);
  }
}
