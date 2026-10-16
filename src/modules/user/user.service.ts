import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { generateHash } from '../../common/utils';
import { StaffRole } from '../../constants';
import { RedisCacheService } from '../cache/redis-cache.service';
import { UserEntity } from './user.entity';

interface ICreateUserPayload {
  username: string;
  email?: string | null;
  passwordHash: string;
  role?: StaffRole;
  isActive?: boolean;
}

@Injectable()
export class UserService {
  private static readonly authUserCacheKeyPrefix = 'auth:user';

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly redisCacheService: RedisCacheService,
  ) {}

  findById(id: Uuid): Promise<UserEntity | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  findByUsername(username: string): Promise<UserEntity | null> {
    return this.userRepository.findOne({
      where: { username: this.normalizeUsername(username) },
    });
  }

  findByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepository.findOne({
      where: { email: email.trim().toLowerCase() },
    });
  }

  findByUsernameWithPassword(username: string): Promise<UserEntity | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.username = :username', {
        username: this.normalizeUsername(username),
      })
      .getOne();
  }

  findByEmailWithPassword(email: string): Promise<UserEntity | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email: email.trim().toLowerCase() })
      .andWhere('user.emailVerifiedAt IS NOT NULL')
      .getOne();
  }

  async findByIdentifierWithPassword(
    identifier: string,
  ): Promise<UserEntity | null> {
    const normalized = identifier.trim().toLowerCase();

    if (normalized.includes('@')) {
      return this.findByEmailWithPassword(normalized);
    }

    return this.findByUsernameWithPassword(normalized);
  }

  async createUser(payload: ICreateUserPayload): Promise<UserEntity> {
    const rawEmail =
      payload.email === null || payload.email === undefined
        ? ''
        : String(payload.email).trim();
    const email = rawEmail.length > 0 ? rawEmail.toLowerCase() : null;

    const entity = this.userRepository.create({
      username: this.normalizeUsername(payload.username),
      email,
      passwordHash: payload.passwordHash,
      role: payload.role ?? StaffRole.NURSE,
      isActive: payload.isActive ?? true,
      emailVerifiedAt: null,
    });

    return this.userRepository.save(entity);
  }

  async createUserWithPlainPassword(payload: {
    username: string;
    email?: string | null;
    password: string;
    role: StaffRole;
    isActive?: boolean;
  }): Promise<UserEntity> {
    const existingUsername = await this.findByUsername(payload.username);

    if (existingUsername) {
      throw new ConflictException('Username already exists');
    }

    const rawEmail = payload.email?.trim() ?? '';
    const emailNormalized = rawEmail.length > 0 ? rawEmail.toLowerCase() : null;

    if (emailNormalized) {
      const existingEmail = await this.findByEmail(emailNormalized);

      if (existingEmail) {
        throw new ConflictException('Email already exists');
      }
    }

    return this.createUser({
      username: payload.username,
      email: payload.email,
      passwordHash: generateHash(payload.password),
      role: payload.role,
      isActive: payload.isActive,
    });
  }

  async updatePassword(id: Uuid, passwordHash: string): Promise<void> {
    await this.userRepository.update({ id }, { passwordHash });
    await this.invalidateAuthUserCache(id, 'update-password');
  }

  async updateRole(id: Uuid, role: StaffRole): Promise<UserEntity | null> {
    await this.userRepository.update({ id }, { role });
    await this.invalidateAuthUserCache(id, 'update-role');

    return this.findById(id);
  }

  async markEmailVerified(id: Uuid, email: string): Promise<UserEntity | null> {
    await this.userRepository.update(
      { id },
      { email: email.trim().toLowerCase(), emailVerifiedAt: new Date() },
    );
    await this.invalidateAuthUserCache(id, 'verify-email');

    return this.findById(id);
  }

  findAllUsers(): Promise<UserEntity[]> {
    return this.userRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async updateUser(
    userId: Uuid,
    payload: {
      username?: string;
      email?: string | null;
      password?: string;
      role?: StaffRole;
      isActive?: boolean;
    },
  ): Promise<UserEntity | null> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      return null;
    }

    if (payload.username !== undefined) {
      const normalizedUsername = this.normalizeUsername(payload.username);
      const existing = await this.findByUsername(normalizedUsername);

      if (existing && existing.id !== userId) {
        throw new ConflictException('Username already exists');
      }

      user.username = normalizedUsername;
    }

    if (payload.email !== undefined) {
      const email =
        payload.email?.trim().length === 0
          ? null
          : payload.email?.trim().toLowerCase();

      if (email) {
        const existing = await this.findByEmail(email);

        if (existing && existing.id !== userId) {
          throw new ConflictException('Email already exists');
        }
      }

      user.email = email ?? null;
      user.emailVerifiedAt = email ? user.emailVerifiedAt : null;
    }

    if (payload.password) {
      user.passwordHash = generateHash(payload.password);
    }

    if (payload.role !== undefined) {
      user.role = payload.role;
    }

    if (payload.isActive !== undefined) {
      user.isActive = payload.isActive;
    }

    await this.userRepository.save(user);
    await this.invalidateAuthUserCache(userId, 'update-user');

    return this.findById(userId);
  }

  async deactivateUser(userId: Uuid): Promise<UserEntity | null> {
    return this.updateUser(userId, { isActive: false });
  }

  private normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  private invalidateAuthUserCache(id: Uuid, action: string): Promise<void> {
    return this.redisCacheService.delete(
      `${UserService.authUserCacheKeyPrefix}:${id}`,
      `auth-user ${action} userId=${id}`,
    );
  }
}
