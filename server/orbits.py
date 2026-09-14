"""Meters, seconds, WGS84 Earth-fixed coordinates. Demo orbits are synthetic."""
import numpy as np
from sgp4.api import Satrec
A, B, MU = 6378137.0, 6356752.314245, 3.986004418e14

def gmst(unix):
    jd = np.asarray(unix) / 86400 + 2440587.5
    t = (jd - 2451545) / 36525
    return np.deg2rad((280.46061837 + 360.98564736629 * (jd - 2451545)
        + .000387933*t*t - t*t*t/38710000) % 360)

def rotate_earth(xyz, unix):
    angle = gmst(unix)
    c, s = np.cos(angle), np.sin(angle)
    out = np.array(xyz, copy=True)
    out[..., 0] = xyz[..., 0]*c + xyz[..., 1]*s
    out[..., 1] = -xyz[..., 0]*s + xyz[..., 1]*c
    return out

def target_vectors(rows):
    lat = np.deg2rad([r['latitude'] for r in rows])
    lon = np.deg2rad([r['longitude'] for r in rows])
    normal = np.column_stack((np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)))
    e2 = 1 - (B/A)**2
    n = A / np.sqrt(1-e2*np.sin(lat)**2)
    xyz = normal*n[:, None]
    xyz[:, 2] *= 1-e2
    return xyz, normal

def sun_direction(unix):
    # Low-order apparent solar position. No atmosphere, refraction or terrain.
    d = np.asarray(unix)/86400 + 2440587.5 - 2451545
    g = np.deg2rad((357.529 + .98560028*d) % 360)
    lon = np.deg2rad((280.459 + .98564736*d + 1.915*np.sin(g) + .020*np.sin(2*g)) % 360)
    eps = np.deg2rad(23.439 - .00000036*d)
    xyz = np.stack((np.cos(lon), np.cos(eps)*np.sin(lon), np.sin(eps)*np.sin(lon)), axis=-1)
    return rotate_earth(xyz, unix)

def positions(fleet, unix):
    unix = np.atleast_1d(unix).astype(float)
    result = np.empty((len(unix), len(fleet), 3))
    for si, sat in enumerate(fleet):
        if sat['kind'] == 'tle':
            rec = Satrec.twoline2rv(sat['line1'], sat['line2'])
            jd = unix/86400 + 2440587.5
            whole = np.floor(jd)
            errors, xyz, _ = rec.sgp4_array(whole, jd-whole)
            if np.any(errors):
                raise ValueError(f"Propagation failed for {sat['name']}; refresh its TLE (codes {np.unique(errors).tolist()})")
            xyz *= 1000
        else:
            r = A + sat['altitude_km']*1000
            phase = sat['phase'] + (unix-sat['epoch'])*np.sqrt(MU/r**3)
            inc, raan = np.deg2rad(sat['inclination_deg']), sat['raan']
            x, y = r*np.cos(phase), r*np.sin(phase)
            xyz = np.column_stack((np.cos(raan)*x - np.sin(raan)*y*np.cos(inc),
                np.sin(raan)*x + np.cos(raan)*y*np.cos(inc), y*np.sin(inc)))
        result[:, si] = rotate_earth(xyz, unix)
    return result

def demo_fleet(count=100, altitude_km=550, inclination_deg=53, epoch=1789128000):
    planes = max(1, int(np.sqrt(count)))
    return [dict(id=f'demo-{i+1}', name=f'DEMO {i+1:03}', kind='demo', altitude_km=altitude_km,
        inclination_deg=inclination_deg, epoch=epoch, raan=2*np.pi*(i % planes)/planes,
        phase=2*np.pi*(i//planes)/np.ceil(count/planes) + (i%planes)*.13) for i in range(count)]
