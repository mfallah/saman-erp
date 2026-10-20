"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Public = exports.IS_PUBLIC_KEY = void 0;
const common_1 = require("@nestjs/common");
/** Marks a route as anonymous (only auth entrypoints, health, webhooks, metrics). */
exports.IS_PUBLIC_KEY = 'saman:isPublic';
/** `@Public()` exempts a controller/handler from the default-deny auth guard. */
const Public = () => (0, common_1.SetMetadata)(exports.IS_PUBLIC_KEY, true);
exports.Public = Public;
