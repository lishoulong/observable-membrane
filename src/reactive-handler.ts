import {
    toString,
    isUndefined,
    unwrap,
    ArrayConcat,
    isArray,
    ObjectDefineProperty,
    getPrototypeOf,
    isExtensible,
    getOwnPropertyDescriptor,
    getOwnPropertyNames,
    getOwnPropertySymbols,
    preventExtensions,
    hasOwnProperty,
} from './shared';

import {
    ReactiveMembrane,
    ReactiveMembraneShadowTarget,
    wrapDescriptor,
} from './reactive-membrane';

function wrapValue(membrane: ReactiveMembrane, value: any): any {
    return membrane.valueIsObservable(value) ? membrane.getProxy(value) : value;
}

/**
 * Unwrap property descriptors will set value on original descriptor
 * We only need to unwrap if value is specified
 * @param descriptor external descrpitor provided to define new property on original value
 */
function unwrapDescriptor(descriptor: PropertyDescriptor): PropertyDescriptor {
    if (hasOwnProperty.call(descriptor, 'value')) {
        descriptor.value = unwrap(descriptor.value);
    }
    return descriptor;
}

function lockShadowTarget(membrane: ReactiveMembrane, shadowTarget: ReactiveMembraneShadowTarget, originalTarget: any): void {
    const targetKeys = ArrayConcat.call(getOwnPropertyNames(originalTarget), getOwnPropertySymbols(originalTarget));
    targetKeys.forEach((key: PropertyKey) => {
        let descriptor = getOwnPropertyDescriptor(originalTarget, key) as PropertyDescriptor;

        // We do not need to wrap the descriptor if configurable
        // Because we can deal with wrapping it when user goes through
        // Get own property descriptor. There is also a chance that this descriptor
        // could change sometime in the future, so we can defer wrapping
        // until we need to
        if (!descriptor.configurable) {
            descriptor = wrapDescriptor(membrane, descriptor, wrapValue);
        }
        ObjectDefineProperty(shadowTarget, key, descriptor);
    });

    preventExtensions(shadowTarget);
}

export class ReactiveProxyHandler {
    private originalTarget: any;
    private membrane: ReactiveMembrane;

    constructor(membrane: ReactiveMembrane, value: any) {
        this.originalTarget = value;
        this.membrane = membrane;
    }
    get(shadowTarget: ReactiveMembraneShadowTarget, key: PropertyKey): any {
        const { originalTarget, membrane } = this;
        const value = originalTarget[key];
        const { valueObserved } = membrane;
        valueObserved(originalTarget, key);
        return membrane.getProxy(value);
    }
    set(shadowTarget: ReactiveMembraneShadowTarget, key: PropertyKey, value: any): boolean {
        const { originalTarget, membrane: { valueMutated } } = this;
        const oldValue = originalTarget[key];
        if (oldValue !== value) {
            originalTarget[key] = value;
            valueMutated(originalTarget, key);
        } else if (key === 'length' && isArray(originalTarget)) {
            // fix for issue #236: push will add the new index, and by the time length
            // is updated, the internal length is already equal to the new length value
            // therefore, the oldValue is equal to the value. This is the forking logic
            // to support this use case.
            valueMutated(originalTarget, key);
        }
        return true;
    }
    deleteProperty(shadowTarget: ReactiveMembraneShadowTarget, key: PropertyKey): boolean {
        const { originalTarget, membrane: { valueMutated } } = this;
        delete originalTarget[key];
        valueMutated(originalTarget, key);
        return true;
    }
    apply(shadowTarget: ReactiveMembraneShadowTarget, thisArg: any, argArray: any[]) {
        /* No op */
    }
    construct(target: ReactiveMembraneShadowTarget, argArray: any, newTarget?: any): any {
        /* No op */
    }
    has(shadowTarget: ReactiveMembraneShadowTarget, key: PropertyKey): boolean {
        const { originalTarget, membrane: { valueObserved } } = this;
        valueObserved(originalTarget, key);
        return key in originalTarget;
    }
    ownKeys(shadowTarget: ReactiveMembraneShadowTarget): string[] {
        const { originalTarget } = this;
        return ArrayConcat.call(getOwnPropertyNames(originalTarget), getOwnPropertySymbols(originalTarget));
    }
    isExtensible(shadowTarget: ReactiveMembraneShadowTarget): boolean {
        const shadowIsExtensible = isExtensible(shadowTarget);

        if (!shadowIsExtensible) {
            return shadowIsExtensible;
        }

        const { originalTarget, membrane } = this;
        const targetIsExtensible = isExtensible(originalTarget);

        if (!targetIsExtensible) {
            lockShadowTarget(membrane, shadowTarget, originalTarget);
        }

        return targetIsExtensible;
    }
    setPrototypeOf(shadowTarget: ReactiveMembraneShadowTarget, prototype: any): any {
        if (process.env.NODE_ENV !== 'production') {
            throw new Error(`Invalid setPrototypeOf invocation for reactive proxy ${toString(this.originalTarget)}. Prototype of reactive objects cannot be changed.`);
        }
    }
    getPrototypeOf(shadowTarget: ReactiveMembraneShadowTarget): object {
        const { originalTarget } = this;
        return getPrototypeOf(originalTarget);
    }
    getOwnPropertyDescriptor(shadowTarget: ReactiveMembraneShadowTarget, key: PropertyKey): PropertyDescriptor | undefined {
        const { originalTarget, membrane } = this;
        const { valueObserved } = this.membrane;

        // keys looked up via hasOwnProperty need to be reactive
        valueObserved(originalTarget, key);

        let desc = getOwnPropertyDescriptor(originalTarget, key);
        if (isUndefined(desc)) {
            return desc;
        }
        const shadowDescriptor = getOwnPropertyDescriptor(shadowTarget, key);
        if (!isUndefined(shadowDescriptor)) {
            return shadowDescriptor;
        }
        // Note: by accessing the descriptor, the key is marked as observed
        // but access to the value, setter or getter (if available) cannot observe
        // mutations, just like regular methods, in which case we just do nothing.
        desc = wrapDescriptor(membrane, desc, wrapValue);
        if (!desc.configurable) {
            // If descriptor from original target is not configurable,
            // We must copy the wrapped descriptor over to the shadow target.
            // Otherwise, proxy will throw an invariant error.
            // This is our last chance to lock the value.
            // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/getOwnPropertyDescriptor#Invariants
            ObjectDefineProperty(shadowTarget, key, desc);
        }
        return desc;
    }
    preventExtensions(shadowTarget: ReactiveMembraneShadowTarget): boolean {
        const { originalTarget, membrane } = this;
        lockShadowTarget(membrane, shadowTarget, originalTarget);
        preventExtensions(originalTarget);
        return true;
    }
    defineProperty(shadowTarget: ReactiveMembraneShadowTarget, key: PropertyKey, descriptor: PropertyDescriptor): boolean {
        const { originalTarget, membrane } = this;
        const { valueMutated } = membrane;
        const { configurable } = descriptor;

        // We have to check for value in descriptor
        // because Object.freeze(proxy) calls this method
        // with only { configurable: false, writeable: false }
        // Additionally, method will only be called with writeable:false
        // if the descriptor has a value, as opposed to getter/setter
        // So we can just check if writable is present and then see if
        // value is present. This eliminates getter and setter descriptors
        if (hasOwnProperty.call(descriptor, 'writable') && !hasOwnProperty.call(descriptor, 'value')) {
            const originalDescriptor = getOwnPropertyDescriptor(originalTarget, key) as PropertyDescriptor;
            descriptor.value = originalDescriptor.value;
        }
        ObjectDefineProperty(originalTarget, key, unwrapDescriptor(descriptor));
        if (configurable === false) {
            ObjectDefineProperty(shadowTarget, key, wrapDescriptor(membrane, descriptor, wrapValue));
        }

        valueMutated(originalTarget, key);
        return true;
    }
}
