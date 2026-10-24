// The only entry point other code may import from this module (ADR-0008 decision 6).
export * from './contracts';
export { IdentityModule } from './identity.module';
export {
  IDENTITY_OPERATOR_COMMANDS,
  IDENTITY_OPERATOR_USAGE,
} from './presentation/commands/admin-operator-commands';
