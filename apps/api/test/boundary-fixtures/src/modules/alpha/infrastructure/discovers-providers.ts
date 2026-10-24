import { DiscoveryModule, DiscoveryService, ModulesContainer } from '@nestjs/core';

// Violations: provider discovery would reach the platform's factory without naming it.
export const violation = [DiscoveryModule, DiscoveryService, ModulesContainer];
