from datetime import datetime, timezone
import json
import numpy as np
import pytest
from scipy.spatial import cKDTree
from server.models import Scenario, Constraints, Generate
from server.orbits import A, target_vectors, sun_direction, positions, demo_fleet
from server import engine

def scenario(**rules):
    return Scenario(start=datetime(2026,9,11,12,tzinfo=timezone.utc),duration_seconds=120,
        constraints=Constraints(daylight_only=False,step_seconds=10,dwell_seconds=20,cooldown_seconds=10,**rules))

def test_nadir_horizon_and_night():
    rows=[dict(latitude=0,longitude=0),dict(latitude=0,longitude=180),dict(latitude=0,longitude=20)]
    xyz,normals=target_vectors(rows)
    sat=np.array([A+550000,0,0])
    c=Constraints(daylight_only=False,max_off_nadir_deg=85,min_elevation_deg=0)
    assert engine.visible(xyz,normals,sat,np.array([1,0,0]),c).tolist()==[True,False,True]
    c.max_off_nadir_deg=10
    assert engine.visible(xyz,normals,sat,np.array([1,0,0]),c).tolist()==[True,False,False]
    c.daylight_only=True
    assert not engine.visible(xyz,normals,sat,np.array([-1,0,0]),c).any()

def test_sun_equinox_and_earth_rotation():
    noon=datetime(2026,3,20,12,tzinfo=timezone.utc).timestamp()
    sun=sun_direction(np.array([noon,noon+43200]))
    assert sun[0,0]>.99 and sun[1,0]<-.99
    assert np.allclose(np.linalg.norm(sun,axis=1),1)
    track=positions(demo_fleet(3),[noon,noon+10])
    assert track.shape==(2,3,3)
    assert np.allclose(np.linalg.norm(track,axis=2),A+550000)
    assert not np.allclose(track[0],track[1])

def test_spatial_filter_never_drops_visible_candidates():
    rng=np.random.default_rng(7)
    rows=[dict(latitude=float(lat),longitude=float(lon)) for lat,lon in zip(rng.uniform(-90,90,12000),rng.uniform(-180,180,12000))]
    xyz,n=target_vectors(rows)
    tree=cKDTree(xyz/np.linalg.norm(xyz,axis=1)[:,None])
    for angle in (0,10,45,65,85):
        c=Constraints(daylight_only=False,max_off_nadir_deg=angle,min_elevation_deg=0)
        for sat in positions(demo_fleet(20),[1789128000])[0]:
            exact=set(np.flatnonzero(engine.visible(xyz,n,sat,np.array([1,0,0]),c)))
            assert exact.issubset(set(engine.candidates(tree,sat,c)))

def static_positions(fleet,times):
    return np.tile([A+550000,0,0],(len(np.atleast_1d(times)),len(fleet),1))

def test_priority_capacity_cooldown_and_uniqueness(monkeypatch,tmp_path):
    monkeypatch.setattr(engine,'positions',static_positions)
    rows=[dict(id=i,name=str(i),latitude=0,longitude=0,priority=p) for i,p in enumerate([1,90,5,80,8,7,3,2])]
    feasible,observed,events,_=engine.access(rows,demo_fleet(2),scenario(),tmp_path)
    assert feasible.all() and observed.all()
    assert [e['target_id'] for e in events[:2]]==[1,3]
    assert len({e['target_id'] for e in events})==len(events)
    for si in range(2):
        assigned=[e for e in events if e['satellite_index']==si]
        assert all(b['start']>=a['end']+10 for a,b in zip(assigned,assigned[1:]))
    assert all(e['end']<=120 for e in events)

def test_multi_capacity_and_no_concurrent_duplicate(monkeypatch,tmp_path):
    monkeypatch.setattr(engine,'positions',static_positions)
    rows=[dict(id=i,name=str(i),latitude=0,longitude=0,priority=1) for i in range(5)]
    _,_,events,_=engine.access(rows,demo_fleet(2),scenario(capacity_per_satellite=2,observe_target_once=False),tmp_path)
    for t in range(120):
        active=[e for e in events if e['start']<=t<e['end']]
        assert len({e['target_id'] for e in active})==len(active)
        for si in range(2):
            assert sum(e['satellite_index']==si for e in active)<=2

def test_daylight_required_through_dwell(monkeypatch,tmp_path):
    monkeypatch.setattr(engine,'positions',static_positions)
    spec=scenario()
    spec.constraints.daylight_only=True
    start=spec.start.timestamp()
    monkeypatch.setattr(engine,'sun_direction',lambda times: np.array([[1,0,0] if t<start+10 else [-1,0,0] for t in times]))
    feasible,_,events,_=engine.access([dict(id=1,latitude=0,longitude=0,priority=1)],demo_fleet(1),spec,tmp_path)
    assert not feasible.any() and not events

def test_cancel(tmp_path):
    (tmp_path/'cancel').touch()
    with pytest.raises(InterruptedError):
        engine.report(tmp_path,0,'working')

def test_random_reproducible_and_date_line(monkeypatch,tmp_path):
    stored=[]
    monkeypatch.setattr(engine.db,'insert_targets',lambda rows: stored.append(rows))
    req=Generate(start=datetime(2026,9,11,12,tzinfo=timezone.utc),count=100,seed=13,west=170,east=-170,south=-10,north=10,feasible_only=False).model_dump(mode='json')
    first=engine.run_generate(req,demo_fleet(1),str(tmp_path))
    engine.run_generate(req,demo_fleet(1),str(tmp_path))
    assert stored[0]==stored[1] and first['accepted']==100
    assert all(-10<=r['latitude']<=10 and abs(r['longitude'])>=170 for r in stored[0])

def test_artifact_layout_and_snapshot(tmp_path):
    rows=[dict(id=1,name='Origin',latitude=0,longitude=0,priority=1)]
    result=engine.run_schedule(scenario().model_dump(mode='json'),demo_fleet(2),rows,str(tmp_path))
    assert np.fromfile(tmp_path/'positions.bin',dtype='<f8').size==result['sample_count']*2*3
    assert np.fromfile(tmp_path/'targets.bin',dtype='<f8').size==6
    assert json.loads((tmp_path/'result.json').read_text())['counts']['targets']==1
