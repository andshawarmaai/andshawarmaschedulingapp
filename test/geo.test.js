import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, isGeofenceConfigured, checkGeofence } from '../src/lib/geo.js';

test('distanceMeters returns ~0 for identical coordinates', () => {
  assert.ok(distanceMeters(40.7128, -74.0060, 40.7128, -74.0060) < 0.01);
});

test('distanceMeters matches a known real-world distance within 1% (NYC to Philadelphia, ~130km)', () => {
  const d = distanceMeters(40.7128, -74.0060, 39.9526, -75.1652);
  assert.ok(d > 128000 && d < 132000, `expected ~130000m, got ${d}`);
});

test('isGeofenceConfigured is false when any of lat/lng/radius is missing', () => {
  assert.equal(isGeofenceConfigured(null), false);
  assert.equal(isGeofenceConfigured({ lat: 1, lng: 2, geofence_radius_meters: null }), false);
  assert.equal(isGeofenceConfigured({ lat: null, lng: 2, geofence_radius_meters: 100 }), false);
  assert.equal(isGeofenceConfigured({ lat: 1, lng: 2, geofence_radius_meters: 0 }), true);
});

test('checkGeofence fails closed (not "not_configured" masquerading as ok) when the location has no geofence set', () => {
  const result = checkGeofence(40.7128, -74.0060, { lat: null, lng: null, geofence_radius_meters: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

test('checkGeofence passes for a point well inside the radius', () => {
  const location = { lat: 39.1434, lng: -77.2014, geofence_radius_meters: 150 };
  const result = checkGeofence(39.1434, -77.2015, location); // ~a few meters away
  assert.equal(result.ok, true);
  assert.ok(result.distanceMeters < 150);
});

test('checkGeofence rejects a point outside the radius, and reports the real distance', () => {
  const location = { lat: 39.1434, lng: -77.2014, geofence_radius_meters: 100 };
  const result = checkGeofence(39.1500, -77.2014, location); // ~730m north
  assert.equal(result.ok, false);
  assert.ok(result.distanceMeters > 100);
});
