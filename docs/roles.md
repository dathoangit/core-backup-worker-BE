# Roles & authorization

Role-only access control via `StaffRole`. Full RBAC permission matrix was removed.

Related: [auth.md](./auth.md), [admin-users.md](./admin-users.md).

---

## Where logic lives

| Concern | File |
|---------|------|
| Role enum | `src/constants/staff-role.ts` |
| Apply JWT + optional roles on route | `src/decorators/http.decorators.ts` (`@Auth`) |
| Mark public route | `src/decorators/public-route.decorator.ts` |
| Inject current user | `src/decorators/auth-user.decorator.ts` |
| JWT / session guard | `src/guards/auth.guard.ts` |
| Role rank check | `src/guards/roles.guard.ts` |
| Roles decorator metadata | `src/decorators/roles.decorator.ts` |

**Add a protected endpoint →** controller method + `@Auth()` or `@Auth([StaffRole.…])`.  
**Change hierarchy →** `src/guards/roles.guard.ts`.  
**Add a new role value →** `staff-role.ts` + FE `src/auth/types.ts` / `role-labels.ts`.

---

## Staff roles

| Role | Value | Typical access |
|------|-------|----------------|
| Nurse | `nurse` | Authenticated base features |
| Doctor | `doctor` | Higher than nurse (rank) |
| Admin | `admin` | `/admin/*`, user management |

Rank: `admin` > `doctor` > `nurse`. Higher rank satisfies lower required role.

---

## How to protect an endpoint

```typescript
import { StaffRole } from '../../constants';
import { Auth } from '../../decorators';

@Auth()                      // any authenticated user
@Auth([StaffRole.ADMIN])     // admin only
@Auth([StaffRole.DOCTOR])    // doctor or admin
@PublicRoute(true)           // skip JWT (auth controller public routes)
```

Guard chain: `AuthGuard` → `RolesGuard`.

---

## Admin API role matrix

`users.role` is still stored on the user and JWT, but admin APIs no longer
enforce a role — any authenticated user may call them.

| Endpoint | Required |
|----------|----------|
| `/admin/users/*` | login (`@Auth()`) |
| `/admin/settings/*` | login (`@Auth()`) |
| `/admin/backup/*` | login (`@Auth()`) |
