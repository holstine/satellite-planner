"""Meters, seconds, WGS84 Earth-fixed coordinates. Demo orbits are synthetic."""

import numpy as np
from sgp4.api import Satrec

A, B, MU = 6378137.0, 6356752.314245, 3.986004418e14


def gmst(unix):
    jd = np.asarray(unix) / 86400 + 2440587.5
    t = (jd - 2451545) / 36525
    return np.deg2rad(
        (280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t - t * t * t / 38710000) % 360
    )


def rotate_earth(xyz, unix):
    angle = gmst(unix)
    c, s = np.cos(angle), np.sin(angle)
    out = np.array(xyz, copy=True)
    out[..., 0] = xyz[..., 0] * c + xyz[..., 1] * s
    out[..., 1] = -xyz[..., 0] * s + xyz[..., 1] * c
    return out


def target_vectors(rows):
    lat = np.deg2rad([r["latitude"] for r in rows])
    lon = np.deg2rad([r["longitude"] for r in rows])
    normal = np.column_stack((np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)))
    e2 = 1 - (B / A) ** 2
    n = A / np.sqrt(1 - e2 * np.sin(lat) ** 2)
    xyz = normal * n[:, None]
    xyz[:, 2] *= 1 - e2
    return xyz, normal


def sun_direction(unix):
    # Low-order apparent solar position. No atmosphere, refraction or terrain.
    d = np.asarray(unix) / 86400 + 2440587.5 - 2451545
    g = np.deg2rad((357.529 + 0.98560028 * d) % 360)
    lon = np.deg2rad((280.459 + 0.98564736 * d + 1.915 * np.sin(g) + 0.020 * np.sin(2 * g)) % 360)
    eps = np.deg2rad(23.439 - 0.00000036 * d)
    xyz = np.stack((np.cos(lon), np.cos(eps) * np.sin(lon), np.sin(eps) * np.sin(lon)), axis=-1)
    return rotate_earth(xyz, unix)


def positions(fleet, unix):
    unix = np.atleast_1d(unix).astype(float)
    result = np.empty((len(unix), len(fleet), 3))
    for si, sat in enumerate(fleet):
        if sat["kind"] == "tle":
            rec = Satrec.twoline2rv(sat["line1"], sat["line2"])
            jd = unix / 86400 + 2440587.5
            whole = np.floor(jd)
            errors, xyz, _ = rec.sgp4_array(whole, jd - whole)
            if np.any(errors):
                raise ValueError(
                    f"Propagation failed for {sat['name']}; refresh its TLE (codes {np.unique(errors).tolist()})"
                )
            xyz *= 1000
        else:
            semi_major = A + sat["altitude_km"] * 1000
            eccentricity = sat.get("eccentricity", 0)
            mean_anomaly = sat["phase"] + (unix - sat["epoch"]) * np.sqrt(MU / semi_major**3)
            eccentric_anomaly = np.array(mean_anomaly, copy=True)
            for _ in range(8):
                eccentric_anomaly -= (
                    eccentric_anomaly - eccentricity * np.sin(eccentric_anomaly) - mean_anomaly
                ) / (1 - eccentricity * np.cos(eccentric_anomaly))
            x = semi_major * (np.cos(eccentric_anomaly) - eccentricity)
            y = semi_major * np.sqrt(1 - eccentricity**2) * np.sin(eccentric_anomaly)
            inc, raan, argp = (
                np.deg2rad(sat["inclination_deg"]),
                sat["raan"],
                sat.get("argument_of_perigee", 0),
            )
            x_perifocal = np.cos(argp) * x - np.sin(argp) * y
            y_perifocal = np.sin(argp) * x + np.cos(argp) * y
            xyz = np.column_stack(
                (
                    np.cos(raan) * x_perifocal - np.sin(raan) * y_perifocal * np.cos(inc),
                    np.sin(raan) * x_perifocal + np.cos(raan) * y_perifocal * np.cos(inc),
                    y_perifocal * np.sin(inc),
                )
            )
        result[:, si] = rotate_earth(xyz, unix)
    return result


def demo_fleet(count=100, altitude_km=550, inclination_deg=53, epoch=1789128000, profile="mixed"):
    """Deterministic synthetic fleet; altitude_km is semi-major altitude for elliptical HEOs."""
    classes = (
        [("LEO", 0.70), ("MEO", 0.15), ("GEO", 0.10), ("HEO", 0.05)] if profile == "mixed" else [("LEO", 1)]
    )
    sizes = [int(count * share) for _, share in classes]
    for i in range(count - sum(sizes)):
        sizes[i % len(sizes)] += 1
    templates = {
        "LEO": dict(altitude_km=altitude_km, inclination_deg=inclination_deg, eccentricity=0),
        "MEO": dict(altitude_km=20200, inclination_deg=56, eccentricity=0),
        "GEO": dict(altitude_km=35786, inclination_deg=0, eccentricity=0),
        "HEO": dict(altitude_km=26600, inclination_deg=63.4, eccentricity=0.72),
    }
    result, index = [], 0
    for (orbit_class, _), size in zip(classes, sizes, strict=True):
        planes = max(1, int(np.sqrt(size)))
        for local in range(size):
            result.append(
                dict(
                    id=f"demo-{index + 1}",
                    name=f"{orbit_class} {local + 1:03}",
                    kind="demo",
                    orbit_class=orbit_class,
                    epoch=epoch,
                    raan=2 * np.pi * (local % planes) / planes,
                    phase=2 * np.pi * (local // planes) / np.ceil(size / planes) + (local % planes) * 0.13,
                    argument_of_perigee=(local % planes) * 2 * np.pi / planes if orbit_class == "HEO" else 0,
                    **templates[orbit_class],
                )
            )
            index += 1
    return result
