import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Post,
  Body,
  Req,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { z } from "zod";
import { setActor } from "../common/context.js";
import { DomainError, forbidden, notFound } from "../common/errors.js";
import { parseBody } from "../common/util.js";
import { CONFIG, type AppConfig } from "../config.js";
import { DB, type Db } from "../db/db.js";

export type Role = "viewer" | "planner" | "senior_planner" | "head_of_replenishment" | "admin";

export interface AppUser {
  userId: string;
  displayName: string;
  roles: Role[];
  /** GBP; null = unlimited */
  approvalLimit: number | null;
}

export const PUBLIC = "replen:public";
export const ROLES = "replen:roles";
export const Public = () => SetMetadata(PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const APPROVER_ROLES: Role[] = ["planner", "senior_planner", "head_of_replenishment"];

export function currentUser(req: Request): AppUser {
  const user = (req as Request & { user?: AppUser }).user;
  if (!user) throw new UnauthorizedException();
  return user;
}

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async find(userId: string): Promise<AppUser | null> {
    const [row] = await this.db.query<{
      user_id: string;
      display_name: string;
      roles: Role[];
      approval_limit: number | null;
      active: boolean;
    }>("SELECT * FROM identity.app_user WHERE user_id = $1", [userId]);
    if (!row || !row.active) return null;
    return { userId: row.user_id, displayName: row.display_name, roles: row.roles, approvalLimit: row.approval_limit };
  }

  async list(): Promise<AppUser[]> {
    const rows = await this.db.query<{ user_id: string }>(
      "SELECT user_id FROM identity.app_user WHERE active ORDER BY user_id",
    );
    return (await Promise.all(rows.map((r) => this.find(r.user_id)))).filter((u): u is AppUser => u !== null);
  }
}

/** HMAC-signed development tokens. Production uses IAP-signed JWTs (not implemented in the slice). */
@Injectable()
export class TokenService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private sign(payload: string): string {
    return createHmac("sha256", this.config.authSecret).update(payload).digest("base64url");
  }

  issue(userId: string, ttlSeconds = 12 * 3600): { token: string; expiresAt: string } {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ sub: userId, exp })).toString("base64url");
    return { token: `${payload}.${this.sign(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  verify(token: string): string | null {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub: string; exp: number };
    if (exp * 1000 < Date.now()) return null;
    return sub;
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    if (this.config.authMode !== "dev") {
      throw new DomainError("AUTH_NOT_IMPLEMENTED", 501, "IAP authentication is not implemented in the slice");
    }
    const req = ctx.switchToHttp().getRequest<Request & { user?: AppUser }>();
    const header = req.headers.authorization ?? "";
    const userId = header.startsWith("Bearer ") ? this.tokens.verify(header.slice(7)) : null;
    if (!userId) throw new UnauthorizedException("missing or invalid token");
    const user = await this.users.find(userId);
    if (!user) throw new UnauthorizedException("unknown or inactive user");
    req.user = user;
    setActor(user.userId);
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (required && !required.some((r) => user.roles.includes(r))) {
      throw forbidden("ROLE_REQUIRED", `requires one of: ${required.join(", ")}`);
    }
    return true;
  }
}

@Controller("api/v1")
export class AuthController {
  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post("auth/dev-token")
  @HttpCode(200)
  async devToken(@Body() body: unknown) {
    if (this.config.authMode !== "dev") throw notFound("route", "auth/dev-token");
    const { userId } = parseBody(z.object({ userId: z.string().min(1) }).strict(), body);
    const user = await this.users.find(userId);
    if (!user) throw notFound("user", userId);
    return { ...this.tokens.issue(userId), user };
  }

  @Public()
  @Get("users")
  async listUsers() {
    if (this.config.authMode !== "dev") throw notFound("route", "users");
    return this.users.list();
  }

  @Get("me")
  me(@Req() req: Request) {
    return currentUser(req);
  }
}
