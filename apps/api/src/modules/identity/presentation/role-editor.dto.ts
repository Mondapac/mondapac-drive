import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the role editor and the role catalogue, both scopes (identity design
// 5.3, 8.6 row 6; slices 10a and 10). A custom role's name is personal free text: it is in the
// catalogue for a holder of the view key and nowhere else (no log, event or audit row, R5).

/** Create or edit a custom role: the whole name and the whole key set. */
export class RoleEditorRequest {
  @ApiProperty({
    description:
      'The role name: 1 to 80 characters after trimming, no control or direction character, ' +
      'unique among the custom roles of the same owner (case-insensitive). Never logged.',
    maxLength: 80,
  })
  name!: string;

  @ApiProperty({
    type: [String],
    description:
      'Every permission the role confers. Keys of the role scope only (see `keys` of the ' +
      'catalogue), each one you may give (`grantable`), at most 40, none twice.',
    maxItems: 40,
  })
  permissionKeys!: string[];
}

export class RoleActionHintView {
  @ApiProperty()
  allowed!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why not: access.denied (you lack the permission), role.read-only, role.not-grantable ' +
      'or role.in-use. Null when allowed. A hint: the command checks again.',
  })
  code!: string | null;
}

export class RoleActionsView {
  @ApiProperty({ type: RoleActionHintView })
  edit!: RoleActionHintView;

  @ApiProperty({ type: RoleActionHintView })
  delete!: RoleActionHintView;
}

export class RoleView {
  @ApiProperty({ format: 'uuid' })
  roleId!: string;

  @ApiProperty({ enum: ['system', 'default', 'custom'], description: 'system: show a lock.' })
  kind!: 'system' | 'default' | 'custom';

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The seed code of a system or default role: its label is a translation key. Null for a ' +
      'custom role.',
  })
  seedCode!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The name of a custom role (personal data). Null for a seeded role.',
  })
  name!: string | null;

  @ApiProperty({
    description: 'How many permissions the role confers now (every one of the scope for system).',
  })
  permissionCount!: number;

  @ApiProperty({
    type: [String],
    description:
      'The permissions the role confers now, sorted: every key of the scope for the system role.',
  })
  permissionKeys!: string[];

  @ApiProperty({
    description:
      'Whether you may give this role now (assign it, invite with it): you hold every ' +
      'permission it confers, a protected one only with the system role of the scope, and the ' +
      'system role only if you hold it. A hint only: the commands check again. It does not ' +
      'say whether you hold the permission to assign or invite.',
  })
  grantable!: boolean;

  @ApiProperty({ description: 'Changes with every edit.' })
  version!: number;

  @ApiProperty({ type: RoleActionsView })
  actions!: RoleActionsView;
}

export class RoleKeyView {
  @ApiProperty({ description: 'A permission key of the scope.' })
  key!: string;

  @ApiProperty({ description: 'Protected keys need the system role of the scope (R11).' })
  protected!: boolean;

  @ApiProperty({
    description:
      'Whether you may put this key in a custom role now. A hint: create and edit check.',
  })
  grantable!: boolean;
}

export class RoleCatalogueView {
  @ApiProperty({
    type: [RoleView],
    description:
      'The roles of the scope, by id: the Market’s system and default roles and the custom ' +
      'roles of your own owner (the Market in platform scope, your seller in seller scope).',
  })
  items!: RoleView[];

  @ApiProperty({
    type: [RoleKeyView],
    description: 'Every permission key of the scope, by key, with whether you may give it.',
  })
  keys!: RoleKeyView[];
}

export class RoleWrittenView {
  @ApiProperty({ enum: ['role.created', 'role.updated', 'role.unchanged', 'role.deleted'] })
  code!: 'role.created' | 'role.updated' | 'role.unchanged' | 'role.deleted';

  @ApiProperty({ format: 'uuid' })
  roleId!: string;
}
