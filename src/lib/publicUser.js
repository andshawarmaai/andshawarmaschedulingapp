// Strips password_hash before a user row ever reaches the client. Every API
// route that returns a user object must pass it through this first.
export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    email: u.email,
    phone: u.phone,
    disabled: u.disabled,
  };
}
