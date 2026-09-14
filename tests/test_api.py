import pytest
from fastapi.testclient import TestClient
from server.app import app
from server import db

@pytest.fixture
def client(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'DATA',tmp_path)
    with TestClient(app) as client:
        yield client

def target(**kw):
    return dict(name='Denver',latitude=39.74,longitude=-104.99,priority=5,enabled=True,**kw)

def test_crud_and_pagination(client):
    created=client.post('/api/targets',json=target())
    assert created.status_code==201
    tid=created.json()['id']
    assert client.get(f'/api/targets/{tid}').json()['name']=='Denver'
    changed=target();changed['priority']=99
    assert client.put(f'/api/targets/{tid}',json=changed).status_code==200
    assert client.get('/api/targets?limit=1&q=Denver').json()['items'][0]['priority']==99
    assert len(client.get('/api/targets/points').content)==40
    assert 'Denver' in client.get('/api/targets/export').text
    assert client.delete(f'/api/targets/{tid}').status_code==200
    assert client.get(f'/api/targets/{tid}').status_code==404

def test_bulk_atomic_validation(client):
    invalid=target();invalid['latitude']=91
    assert client.post('/api/targets/bulk',json={'targets':[target(),invalid]}).status_code==422
    assert client.get('/api/targets').json()['total']==0
    good='name,latitude,longitude,priority\nA,0,180,1\nB,-90,-180,2'
    assert client.post('/api/targets/import',json={'text':good,'format':'csv'}).json()['inserted']==2
    bad='name,latitude,longitude\nC,1,1\nD,nonsense,2'
    assert client.post('/api/targets/import',json={'text':bad,'format':'csv'}).status_code==422
    assert client.get('/api/targets').json()['total']==2

def test_validation_and_origin(client):
    assert client.post('/api/jobs/schedule',json={'start':'2026-09-11T12:00:00'}).status_code==422
    assert client.post('/api/jobs/schedule',json={'start':'2026-09-11T12:00:00Z'}).status_code==422
    assert client.post('/api/targets',json=target(),headers={'Origin':'https://example.org'}).status_code==403
    assert client.put('/api/satellites/tle',json={'text':'broken'}).status_code==422
    assert client.get('/api/jobs/not-found/files/input.json').status_code==404

def test_constraints_persist(client):
    c=client.get('/api/constraints').json();c['capacity_per_satellite']=2;c['daylight_only']=False
    assert client.put('/api/constraints',json=c).status_code==200
    assert client.get('/api/constraints').json()==c
    c['capacity_per_satellite']=0
    assert client.put('/api/constraints',json=c).status_code==422

def test_import_valid_tle(client):
    # Vallado public SGP4 verification test case (epoch June 2000).
    a='1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753'
    b='2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667'
    r=client.put('/api/satellites/tle',json={'text':'VANGUARD 1\n'+a+'\n'+b})
    assert r.status_code==200, r.text
    assert r.json()[0]['kind']=='tle'
    assert len(client.get('/api/satellites').json())==1
