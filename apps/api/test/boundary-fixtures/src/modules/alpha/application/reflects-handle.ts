class Target {
  protected handle(): number {
    return 1;
  }
}

// Violations (W8): handle reached by reflection, whatever the form: Reflect.get with 'handle'
// (1), a descriptor of the prototype (call and .prototype, 2), all descriptors of the prototype
// (call and .prototype, 2), destructuring (1) and Object.getPrototypeOf (1).
export const viaReflect = (target: Target): unknown => Reflect.get(target, 'handle');
export const viaDescriptor = Object.getOwnPropertyDescriptor(Target.prototype, 'handle');
export const viaDescriptors = Object.values(Object.getOwnPropertyDescriptors(Target.prototype));
export const viaDestructuring = (target: { handle: () => number }): number => {
  const { handle } = target;
  return handle();
};
export const viaPrototypeOf = (target: Target): unknown => Object.getPrototypeOf(target);
