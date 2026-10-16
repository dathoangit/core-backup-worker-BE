import {
  CreateDateColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { type Constructor } from '../types';
import { type AbstractDto } from './dto/abstract.dto';

/**
 * Abstract Entity base for TypeORM models.
 */
export abstract class AbstractEntity<
  DTO extends AbstractDto = AbstractDto,
  O = never,
> {
  @PrimaryGeneratedColumn('uuid')
  id!: Uuid;

  @CreateDateColumn({
    type: 'timestamp',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    type: 'timestamp',
  })
  updatedAt!: Date;

  /**
   * @UseDto sets `dtoClass` on the concrete entity prototype; it must not be a
   * TS `private` field or it will shadow `prototype.dtoClass` and stay undefined.
   */
  toDto(options?: O): DTO {
    const dtoClass = (
      this.constructor as Constructor & {
        prototype: { dtoClass?: Constructor<DTO, [AbstractEntity, O?]> };
      }
    ).prototype.dtoClass;

    if (!dtoClass) {
      throw new Error(
        `You need to use @UseDto on class (${this.constructor.name}) be able to call toDto function`,
      );
    }

    return new dtoClass(this, options);
  }
}
