# Custom Verification Criteria

When verifying work on this project, additionally check:

- All TypeScript files must have proper type annotations (no `any` unless unavoidable)
- Plugin hooks must follow the OpenCode plugin API conventions
- All exported functions must have JSDoc comments
- No console.log in production code (except in the `log()` helper function)
- Files listed in `package.json` `files` field must match actual files on disk
